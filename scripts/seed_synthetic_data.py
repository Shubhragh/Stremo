import os
import random
import sys
from datetime import datetime, timezone

import psycopg2
from psycopg2.extras import execute_values


DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://scalastream:scalastream@localhost:5432/scalastream")
COMMENTS = [
    "Great pacing and storytelling.",
    "Loved the visuals.",
    "Can you share a part 2?",
    "This was super useful!",
    "Watched till the end.",
]


def main():
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM users ORDER BY created_at")
        users = [row[0] for row in cur.fetchall()]

        cur.execute("SELECT id::text, COALESCE(duration_seconds, 120) FROM videos WHERE status = 'READY'")
        videos = cur.fetchall()

        if len(users) < 2 or len(videos) < 2:
            print("Need at least 2 users and 2 READY videos before seeding.")
            sys.exit(1)

        views_batch = []
        likes_batch = []
        comments_batch = []

        for user_id in users:
            sample_videos = random.sample(videos, k=min(len(videos), random.randint(2, 6)))
            for video_id, duration in sample_videos:
                duration = float(duration or 120)
                watch_ratio = random.uniform(0.2, 1.0)
                watch_time = duration * watch_ratio
                completion = min(1.0, watch_ratio + random.uniform(-0.1, 0.1))
                views_batch.append((user_id, video_id, watch_time, completion))

                if random.random() < 0.55:
                    likes_batch.append((user_id, video_id))
                if random.random() < 0.35:
                    comments_batch.append((user_id, video_id, random.choice(COMMENTS)))

        execute_values(
            cur,
            """
            INSERT INTO video_views (user_id, video_id, watch_time_seconds, completion_rate, created_at, updated_at)
            VALUES %s
            """,
            [
                (
                    row[0],
                    row[1],
                    row[2],
                    row[3],
                    datetime.now(timezone.utc),
                    datetime.now(timezone.utc),
                )
                for row in views_batch
            ],
        )

        if likes_batch:
            execute_values(
                cur,
                """
                INSERT INTO video_likes (user_id, video_id, created_at)
                VALUES %s
                ON CONFLICT (user_id, video_id) DO NOTHING
                """,
                [(u, v, datetime.now(timezone.utc)) for (u, v) in likes_batch],
            )

        if comments_batch:
            execute_values(
                cur,
                """
                INSERT INTO video_comments (user_id, video_id, comment_text, created_at)
                VALUES %s
                """,
                [(u, v, c, datetime.now(timezone.utc)) for (u, v, c) in comments_batch],
            )

        cur.execute(
            """
            INSERT INTO video_aggregates (video_id, like_count, comment_count, view_count, watch_time_total, updated_at)
            SELECT
                v.id,
                COALESCE(l.like_count, 0),
                COALESCE(c.comment_count, 0),
                COALESCE(w.view_count, 0),
                COALESCE(w.watch_time_total, 0),
                NOW()
            FROM videos v
            LEFT JOIN (
                SELECT video_id, COUNT(*) AS like_count
                FROM video_likes GROUP BY video_id
            ) l ON l.video_id = v.id
            LEFT JOIN (
                SELECT video_id, COUNT(*) AS comment_count
                FROM video_comments GROUP BY video_id
            ) c ON c.video_id = v.id
            LEFT JOIN (
                SELECT video_id, COUNT(*) AS view_count, SUM(watch_time_seconds) AS watch_time_total
                FROM video_views GROUP BY video_id
            ) w ON w.video_id = v.id
            ON CONFLICT (video_id) DO UPDATE SET
                like_count = EXCLUDED.like_count,
                comment_count = EXCLUDED.comment_count,
                view_count = EXCLUDED.view_count,
                watch_time_total = EXCLUDED.watch_time_total,
                updated_at = NOW()
            """
        )

    conn.commit()
    conn.close()
    print(
        f"Seeded synthetic interactions: views={len(views_batch)}, "
        f"likes={len(likes_batch)}, comments={len(comments_batch)}"
    )


if __name__ == "__main__":
    main()
