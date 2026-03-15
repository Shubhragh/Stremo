import logging
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Dict, Tuple

import boto3
import psycopg2
import redis
from psycopg2.extras import RealDictCursor

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s | %(levelname)s | %(message)s",
)
logger = logging.getLogger("transcode-worker")

DATABASE_URL = os.getenv("DATABASE_URL")
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
EVENT_STREAM_KEY = os.getenv("EVENT_STREAM_KEY", "scalastream-events")
EVENT_STREAM_GROUP = os.getenv("EVENT_STREAM_GROUP", "transcode-workers")
EVENT_STREAM_CONSUMER = os.getenv(
    "EVENT_STREAM_CONSUMER",
    f"worker-{os.getenv('HOSTNAME', 'local')}",
)
MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "minio:9000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "minioadmin")
MINIO_RAW_BUCKET = os.getenv("MINIO_RAW_BUCKET", "raw-videos")
MINIO_PROCESSED_BUCKET = os.getenv("MINIO_PROCESSED_BUCKET", "processed-videos")
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "3"))
RETRY_BACKOFF_SECONDS = int(os.getenv("RETRY_BACKOFF_SECONDS", "10"))


def connect_db():
    return psycopg2.connect(DATABASE_URL)


def connect_redis():
    return redis.Redis.from_url(REDIS_URL, decode_responses=True)


def connect_s3():
    return boto3.client(
        "s3",
        endpoint_url=f"http://{MINIO_ENDPOINT}",
        aws_access_key_id=MINIO_ACCESS_KEY,
        aws_secret_access_key=MINIO_SECRET_KEY,
        region_name="us-east-1",
    )


def ensure_consumer_group(rds: redis.Redis) -> None:
    try:
        rds.xgroup_create(EVENT_STREAM_KEY, EVENT_STREAM_GROUP, id="0-0", mkstream=True)
        logger.info("Created redis stream group %s", EVENT_STREAM_GROUP)
    except redis.exceptions.ResponseError as exc:
        if "BUSYGROUP" in str(exc):
            logger.info("Redis stream group already exists")
        else:
            raise


def publish_event(rds: redis.Redis, event_type: str, payload: Dict[str, str]) -> None:
    fields = {"event_type": event_type, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    fields.update({k: str(v) for k, v in payload.items()})
    rds.xadd(EVENT_STREAM_KEY, fields)


def content_type_for(path: Path) -> str:
    if path.suffix == ".m3u8":
        return "application/vnd.apple.mpegurl"
    if path.suffix == ".ts":
        return "video/mp2t"
    if path.suffix in [".jpg", ".jpeg"]:
        return "image/jpeg"
    if path.suffix == ".png":
        return "image/png"
    return "application/octet-stream"


def probe_duration(input_file: Path) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(input_file),
    ]
    try:
        output = subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT).strip()
    except subprocess.CalledProcessError as exc:
        logger.warning(
            "ffprobe failed for %s (continuing with duration=0): %s",
            input_file,
            (exc.output or "").strip()[:500],
        )
        return 0.0

    try:
        return float(output)
    except ValueError:
        logger.warning("ffprobe returned non-numeric duration for %s: %s", input_file, output)
        return 0.0


def validate_input_file(input_file: Path) -> None:
    with input_file.open("rb") as file_obj:
        head = file_obj.read(512)

    if not head:
        raise RuntimeError("Uploaded file is empty and cannot be transcoded.")

    trimmed = head.lstrip().lower()
    if trimmed.startswith(b"<!doctype html") or trimmed.startswith(b"<html"):
        raise RuntimeError("Uploaded file is not a video (received HTML content).")


def run_ffmpeg_variant(
    input_path: Path,
    output_dir: Path,
    height: int,
    video_bitrate: str,
    maxrate: str,
    bufsize: str,
    audio_bitrate: str,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    segment_pattern = str(output_dir / "seg_%03d.ts")
    playlist = str(output_dir / "index.m3u8")
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        f"scale=-2:{height}",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-profile:v",
        "main",
        "-b:v",
        video_bitrate,
        "-maxrate",
        maxrate,
        "-bufsize",
        bufsize,
        "-g",
        "48",
        "-keyint_min",
        "48",
        "-sc_threshold",
        "0",
        "-c:a",
        "aac",
        "-b:a",
        audio_bitrate,
        "-ar",
        "48000",
        "-f",
        "hls",
        "-hls_time",
        "4",
        "-hls_playlist_type",
        "vod",
        "-hls_flags",
        "independent_segments",
        "-hls_segment_filename",
        segment_pattern,
        playlist,
    ]
    logger.info("Running ffmpeg variant at %sp", height)
    subprocess.run(cmd, check=True)


def write_master_playlist(root_output: Path) -> None:
    content = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=928000,RESOLUTION=640x360
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3328000,RESOLUTION=1280x720
720p/index.m3u8
"""
    (root_output / "master.m3u8").write_text(content, encoding="utf-8")


def generate_thumbnail(input_path: Path, output_path: Path) -> bool:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    commands = [
        [
            "ffmpeg",
            "-y",
            "-ss",
            "00:00:01",
            "-i",
            str(input_path),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(output_path),
        ],
        [
            "ffmpeg",
            "-y",
            "-i",
            str(input_path),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(output_path),
        ],
    ]

    for idx, cmd in enumerate(commands):
        try:
            subprocess.run(cmd, check=True)
            if output_path.exists() and output_path.stat().st_size > 0:
                return True
        except subprocess.CalledProcessError as exc:
            logger.warning("Thumbnail command %s failed: %s", idx + 1, exc)
    return False


def upload_hls_directory(s3_client, base_dir: Path, video_id: str) -> str:
    prefix = f"videos/{video_id}"
    for file_path in base_dir.rglob("*"):
        if file_path.is_file():
            relative = file_path.relative_to(base_dir).as_posix()
            object_key = f"{prefix}/{relative}"
            s3_client.upload_file(
                str(file_path),
                MINIO_PROCESSED_BUCKET,
                object_key,
                ExtraArgs={"ContentType": content_type_for(file_path)},
            )
    return prefix


def transcode_video(s3_client, video_id: str, raw_object_key: str) -> Tuple[str, float]:
    temp_dir = Path(tempfile.mkdtemp(prefix=f"scalastream_{video_id}_"))
    key_suffix = Path(raw_object_key).suffix
    if not key_suffix:
        key_suffix = ".bin"
    input_file = temp_dir / f"input_video{key_suffix}"
    output_root = temp_dir / "hls"

    try:
        logger.info("Downloading source video %s", raw_object_key)
        s3_client.download_file(MINIO_RAW_BUCKET, raw_object_key, str(input_file))

        file_size = input_file.stat().st_size if input_file.exists() else 0
        if file_size <= 0:
            raise RuntimeError(f"Downloaded source is empty for key: {raw_object_key}")

        validate_input_file(input_file)
        duration = probe_duration(input_file)

        run_ffmpeg_variant(input_file, output_root / "360p", 360, "800k", "856k", "1200k", "96k")
        run_ffmpeg_variant(input_file, output_root / "720p", 720, "2800k", "2996k", "4200k", "128k")
        write_master_playlist(output_root)
        if not generate_thumbnail(input_file, output_root / "thumbnail.jpg"):
            logger.warning("Thumbnail generation failed for %s", video_id)

        processed_prefix = upload_hls_directory(s3_client, output_root, video_id)
        return processed_prefix, duration
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def get_video_status(conn, video_id: str):
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            "SELECT id, status, raw_object_key FROM videos WHERE id = %s",
            (video_id,),
        )
        return cur.fetchone()


def mark_processing(conn, video_id: str) -> int:
    try:
        conn.rollback()
    except Exception:  # pylint: disable=broad-except
        pass

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO transcode_jobs(video_id, attempts, last_error, last_attempt_at)
            VALUES (%s, 0, NULL, NOW())
            ON CONFLICT (video_id) DO NOTHING
            """,
            (video_id,),
        )
        cur.execute(
            "UPDATE videos SET status = 'PROCESSING' WHERE id = %s AND status <> 'READY'",
            (video_id,),
        )
        cur.execute(
            """
            UPDATE transcode_jobs
            SET attempts = attempts + 1,
                last_attempt_at = NOW(),
                last_error = NULL
            WHERE video_id = %s
            RETURNING attempts
            """,
            (video_id,),
        )
        row = cur.fetchone()
    conn.commit()
    return int(row["attempts"]) if row else 1


def mark_ready(conn, video_id: str, processed_prefix: str, duration: float) -> None:
    try:
        conn.rollback()
    except Exception:  # pylint: disable=broad-except
        pass

    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE videos
            SET status = 'READY',
                processed_prefix = %s,
                duration_seconds = %s,
                updated_at = NOW()
            WHERE id = %s
            """,
            (processed_prefix, duration, video_id),
        )
        cur.execute(
            """
            UPDATE transcode_jobs
            SET last_error = NULL,
                last_attempt_at = NOW()
            WHERE video_id = %s
            """,
            (video_id,),
        )
    conn.commit()


def mark_failed(conn, video_id: str, error_text: str) -> None:
    try:
        conn.rollback()
    except Exception:  # pylint: disable=broad-except
        pass

    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE videos
            SET status = 'FAILED',
                updated_at = NOW()
            WHERE id = %s
            """,
            (video_id,),
        )
        cur.execute(
            """
            INSERT INTO transcode_jobs(video_id, attempts, last_error, last_attempt_at)
            VALUES (%s, 1, %s, NOW())
            ON CONFLICT (video_id) DO UPDATE SET
                last_error = EXCLUDED.last_error,
                last_attempt_at = EXCLUDED.last_attempt_at
            """,
            (video_id, error_text[:2000]),
        )
    conn.commit()


def process_message(rds: redis.Redis, db_conn, s3_client, message_id: str, fields: Dict[str, str]) -> None:
    event_type = fields.get("event_type")
    if event_type != "video_uploaded":
        rds.xack(EVENT_STREAM_KEY, EVENT_STREAM_GROUP, message_id)
        return

    video_id = fields.get("video_id")
    raw_object_key = fields.get("raw_object_key")
    retry_count = int(fields.get("retry_count", "0"))

    if not video_id or not raw_object_key:
        logger.warning("Missing required fields in event %s", fields)
        rds.xack(EVENT_STREAM_KEY, EVENT_STREAM_GROUP, message_id)
        return

    video = get_video_status(db_conn, video_id)
    if not video:
        logger.warning("Video %s not found; acknowledging event", video_id)
        rds.xack(EVENT_STREAM_KEY, EVENT_STREAM_GROUP, message_id)
        return

    if video["status"] == "READY":
        logger.info("Video %s already READY, skipping", video_id)
        rds.xack(EVENT_STREAM_KEY, EVENT_STREAM_GROUP, message_id)
        return

    attempts = mark_processing(db_conn, video_id)
    logger.info("Processing video %s (attempt %s)", video_id, attempts)

    try:
        processed_prefix, duration = transcode_video(
            s3_client=s3_client,
            video_id=video_id,
            raw_object_key=raw_object_key,
        )
        mark_ready(db_conn, video_id, processed_prefix, duration)
        publish_event(
            rds,
            "transcode_completed",
            {
                "video_id": video_id,
                "processed_prefix": processed_prefix,
                "duration_seconds": f"{duration:.3f}",
                "attempts": attempts,
            },
        )
        logger.info("Transcode completed for video %s", video_id)
    except Exception as exc:  # pylint: disable=broad-except
        error_text = str(exc)
        logger.exception("Transcode failed for %s: %s", video_id, error_text)
        mark_failed(db_conn, video_id, error_text)
        publish_event(
            rds,
            "transcode_failed",
            {"video_id": video_id, "attempts": attempts, "error": error_text[:500]},
        )

        non_retriable_markers = [
            "not a video",
            "empty and cannot be transcoded",
        ]
        should_retry = attempts < MAX_RETRIES and not any(
            marker in error_text.lower() for marker in non_retriable_markers
        )

        if should_retry:
            next_retry = retry_count + 1
            backoff = RETRY_BACKOFF_SECONDS * next_retry
            logger.info("Retrying video %s in %s seconds (retry %s)", video_id, backoff, next_retry)
            time.sleep(backoff)
            publish_event(
                rds,
                "video_uploaded",
                {
                    "video_id": video_id,
                    "raw_object_key": raw_object_key,
                    "retry_count": next_retry,
                },
            )
        elif attempts < MAX_RETRIES:
            logger.info("Not retrying video %s due to non-retriable input error", video_id)
    finally:
        rds.xack(EVENT_STREAM_KEY, EVENT_STREAM_GROUP, message_id)


def process_pending_messages(rds: redis.Redis, db_conn, s3_client):
    try:
        response = rds.xautoclaim(
            EVENT_STREAM_KEY,
            EVENT_STREAM_GROUP,
            EVENT_STREAM_CONSUMER,
            min_idle_time=60_000,
            start_id="0-0",
            count=10,
        )
    except redis.exceptions.ResponseError:
        return

    if not response or len(response) < 2:
        return

    messages = response[1]
    for message_id, fields in messages:
        process_message(rds, db_conn, s3_client, message_id, fields)


def main():
    rds = connect_redis()
    db_conn = connect_db()
    db_conn.autocommit = False
    s3_client = connect_s3()

    ensure_consumer_group(rds)
    logger.info("Transcode worker started as consumer %s", EVENT_STREAM_CONSUMER)

    while True:
        process_pending_messages(rds, db_conn, s3_client)
        messages = rds.xreadgroup(
            groupname=EVENT_STREAM_GROUP,
            consumername=EVENT_STREAM_CONSUMER,
            streams={EVENT_STREAM_KEY: ">"},
            count=1,
            block=5000,
        )

        if not messages:
            continue

        for _stream_name, stream_messages in messages:
            for message_id, fields in stream_messages:
                process_message(rds, db_conn, s3_client, message_id, fields)


if __name__ == "__main__":
    main()
