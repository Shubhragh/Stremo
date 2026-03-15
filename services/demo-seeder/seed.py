import os
import time
from pathlib import Path

import requests

API_BASE = os.getenv("API_BASE", "http://api-gateway:8080")
SAMPLE_VIDEO_PATH = Path(os.getenv("SAMPLE_VIDEO_PATH", "/assets/sample.mp4"))
MIN_READY_VIDEOS = max(2, int(os.getenv("MIN_READY_VIDEOS", "6")))
SEED_IF_EMPTY_ONLY = os.getenv("SEED_IF_EMPTY_ONLY", "true").strip().lower() not in ("0", "false", "no")
DEMO_VIDEO_CATALOG = [
    {
        "title": "Distributed Systems Scaling Playbook",
        "description": "Sharding, caching, and queue backpressure explained with production patterns.",
    },
    {
        "title": "ML Recommender Features from Watch Retention",
        "description": "Using completion rate, watch-time, likes, and search intent for ranking.",
    },
    {
        "title": "Transcoding and HLS in Practice",
        "description": "How to package 360p/720p renditions with FFmpeg and serve via edge caches.",
    },
    {
        "title": "Gaming Speedrun Highlights",
        "description": "High-energy moments and short highlight cuts from gameplay sessions.",
    },
    {
        "title": "Travel Street Food Stories",
        "description": "Quick travel snippets with local food discoveries and city moments.",
    },
    {
        "title": "Lo-fi Coding Music Mix",
        "description": "Instrumental focus tracks for coding sessions and deep work.",
    },
]
SEED_USERS = [
    {"email": "demo_creator@scalastream.local", "password": "pass1234"},
    {"email": "demo_viewer@scalastream.local", "password": "pass1234"},
]


def wait_for_health(timeout_seconds=240):
    started = time.time()
    while time.time() - started < timeout_seconds:
        try:
            res = requests.get(f"{API_BASE}/health", timeout=3)
            if res.ok:
                return
        except requests.RequestException:
            pass
        time.sleep(2)
    raise RuntimeError("API gateway did not become healthy in time")


def register_or_login(email: str, password: str):
    payload = {"email": email, "password": password}
    res = requests.post(f"{API_BASE}/auth/register", json=payload, timeout=15)
    if res.status_code in (200, 201):
        data = res.json()
        return data["token"], data["user"]

    res = requests.post(f"{API_BASE}/auth/login", json=payload, timeout=15)
    res.raise_for_status()
    data = res.json()
    return data["token"], data["user"]


def auth_headers(token: str):
    return {"Authorization": f"Bearer {token}"}


def list_videos(token: str, limit: int = 10):
    res = requests.get(f"{API_BASE}/videos", params={"limit": limit}, headers=auth_headers(token), timeout=20)
    res.raise_for_status()
    return res.json().get("items", [])


def upload_video(token: str, title: str, description: str):
    with SAMPLE_VIDEO_PATH.open("rb") as handle:
        files = {"file": (SAMPLE_VIDEO_PATH.name, handle, "video/mp4")}
        data = {"title": title, "description": description}
        res = requests.post(
            f"{API_BASE}/videos/upload",
            headers=auth_headers(token),
            files=files,
            data=data,
            timeout=120,
        )
    res.raise_for_status()
    return res.json()


def wait_until_ready(token: str, video_id: str, timeout_seconds: int = 420):
    started = time.time()
    while time.time() - started < timeout_seconds:
        res = requests.get(f"{API_BASE}/videos/{video_id}/status", headers=auth_headers(token), timeout=15)
        if res.ok:
            status = res.json().get("status")
            if status == "READY":
                return True
            if status == "FAILED":
                return False
        time.sleep(2)
    return False


def normalized_title(value: str) -> str:
    return (value or "").strip().lower()


def ensure_catalog_videos(token: str):
    try:
        videos = list_videos(token, limit=100)
    except Exception as e:
        print(f"[demo-seeder] failed to list videos: {e}, will try uploads anyway")
        videos = []

    if SEED_IF_EMPTY_ONLY and len(videos) > 0:
        print(
            "[demo-seeder] existing videos detected; skipping auto-upload "
            "(SEED_IF_EMPTY_ONLY=true)."
        )
        return videos
    
    existing_titles = {normalized_title(row.get("title")) for row in videos}
    missing_catalog = [item for item in DEMO_VIDEO_CATALOG if normalized_title(item["title"]) not in existing_titles]
    
    # If we already have enough videos and no missing ones, return
    if len(videos) >= MIN_READY_VIDEOS and not missing_catalog:
        return videos

    if not SAMPLE_VIDEO_PATH.exists():
        print(f"[demo-seeder] sample video missing at {SAMPLE_VIDEO_PATH}, skipping auto-upload")
        return videos

    # Upload missing videos
    uploaded_ids = []
    for item in missing_catalog:
        try:
            payload = upload_video(token, title=item["title"], description=item["description"])
            uploaded_ids.append(payload["id"])
            print(f"[demo-seeder] uploaded video {payload['id']} ({item['title']})")
        except Exception as e:
            print(f"[demo-seeder] failed to upload {item['title']}: {e}")
            continue

    # Wait for transcoding
    for video_id in uploaded_ids:
        try:
            ready = wait_until_ready(token, video_id)
            print(f"[demo-seeder] transcode {video_id}: {'READY' if ready else 'NOT_READY'}")
        except Exception as e:
            print(f"[demo-seeder] failed to wait for {video_id}: {e}")
            continue

    try:
        return list_videos(token, limit=100)
    except Exception as e:
        print(f"[demo-seeder] failed to list videos after upload: {e}")
        return videos


def post_search_query(token: str, query: str):
    try:
        requests.post(
            f"{API_BASE}/videos/history/search",
            headers=auth_headers(token),
            json={"query": query},
            timeout=10,
        )
    except requests.RequestException:
        pass


def post_view_event(token: str, video_id: str, session_id: str, watch_seconds: float, completion_rate: float):
    try:
        requests.post(
            f"{API_BASE}/videos/{video_id}/view",
            headers=auth_headers(token),
            json={
                "sessionId": session_id,
                "watchTimeSeconds": watch_seconds,
                "completionRate": completion_rate,
                "durationSeconds": 6.0,
            },
            timeout=10,
        )
    except requests.RequestException:
        pass


def post_like(token: str, video_id: str):
    try:
        requests.post(f"{API_BASE}/videos/{video_id}/like", headers=auth_headers(token), timeout=10)
    except requests.RequestException:
        pass


def post_comment(token: str, video_id: str, comment: str):
    try:
        requests.post(
            f"{API_BASE}/videos/{video_id}/comment",
            headers=auth_headers(token),
            json={"comment": comment},
            timeout=10,
        )
    except requests.RequestException:
        pass


def pick_video_sets(videos):
    by_title = [(row["id"], normalized_title(row.get("title"))) for row in videos]
    creator_keywords = ("distributed", "scaling", "recommender", "retention", "transcoding", "hls")
    viewer_keywords = ("gaming", "travel", "music", "lo-fi", "street food")

    creator_pref = [vid for vid, title in by_title if any(key in title for key in creator_keywords)]
    viewer_pref = [vid for vid, title in by_title if any(key in title for key in viewer_keywords)]

    all_ids = [row["id"] for row in videos]
    for vid in all_ids:
        if len(creator_pref) >= 3:
            break
        if vid not in creator_pref:
            creator_pref.append(vid)
    for vid in all_ids:
        if len(viewer_pref) >= 3:
            break
        if vid not in viewer_pref:
            viewer_pref.append(vid)

    creator_pref = creator_pref[:3]
    viewer_pref = viewer_pref[:3]

    creator_secondary = [vid for vid in viewer_pref if vid not in creator_pref]
    viewer_secondary = [vid for vid in creator_pref if vid not in viewer_pref]

    return creator_pref, viewer_pref, creator_secondary, viewer_secondary


def seed_interactions(tokens, users, videos):
    if not videos:
        return

    creator_token = tokens[0]
    viewer_token = tokens[1]
    creator_user = users[0]
    viewer_user = users[1]

    creator_pref, viewer_pref, creator_secondary, viewer_secondary = pick_video_sets(videos)

    for query in [
        "distributed systems architecture",
        "hls transcoding strategy",
        "watch retention modeling",
        "ml recommendation ranking",
    ]:
        post_search_query(creator_token, query)

    for query in [
        "gaming highlights",
        "travel short clips",
        "music mix for coding",
        "engaging short videos",
    ]:
        post_search_query(viewer_token, query)

    for index, video_id in enumerate(creator_pref):
        post_like(creator_token, video_id)
        post_comment(creator_token, video_id, "Useful systems insight.")
        post_view_event(
            creator_token,
            video_id,
            session_id=f"seed-creator-pref-{index}-{video_id}",
            watch_seconds=5.2,
            completion_rate=0.88,
        )

    for index, video_id in enumerate(viewer_pref):
        post_like(viewer_token, video_id)
        post_comment(viewer_token, video_id, "Loved this clip.")
        post_view_event(
            viewer_token,
            video_id,
            session_id=f"seed-viewer-pref-{index}-{video_id}",
            watch_seconds=5.4,
            completion_rate=0.91,
        )

    for index, video_id in enumerate(creator_secondary):
        post_view_event(
            creator_token,
            video_id,
            session_id=f"seed-creator-secondary-{index}-{video_id}",
            watch_seconds=1.4,
            completion_rate=0.23,
        )

    for index, video_id in enumerate(viewer_secondary):
        post_view_event(
            viewer_token,
            video_id,
            session_id=f"seed-viewer-secondary-{index}-{video_id}",
            watch_seconds=1.3,
            completion_rate=0.22,
        )

    requests.get(
        f"{API_BASE}/feed/recommended",
        params={"userId": creator_user["id"], "limit": 1},
        headers=auth_headers(creator_token),
        timeout=10,
    )
    requests.get(
        f"{API_BASE}/feed/recommended",
        params={"userId": viewer_user["id"], "limit": 1},
        headers=auth_headers(viewer_token),
        timeout=10,
    )
    requests.post(f"{API_BASE}/feed/train", timeout=30)


def main():
    print("[demo-seeder] waiting for health...")
    wait_for_health()

    # Always create demo user accounts - this is critical for testing
    tokens = []
    users = []
    for user in SEED_USERS:
        try:
            token, profile = register_or_login(user["email"], user["password"])
            tokens.append(token)
            users.append(profile)
            print(f"[demo-seeder] account ready: {user['email']}")
        except Exception as e:
            print(f"[demo-seeder] failed to create account {user['email']}: {e}")
            return
    
    # Try to get existing videos, but don't fail if this doesn't work
    try:
        existing = list_videos(tokens[0], limit=100)
        print(f"[demo-seeder] existing READY videos: {len(existing)}")
    except Exception as e:
        print(f"[demo-seeder] failed to list existing videos: {e}")
        existing = []
    
    # Ensure catalog videos - if this fails, still finish with what we have
    try:
        videos = ensure_catalog_videos(tokens[0])
    except Exception as e:
        print(f"[demo-seeder] failed to ensure catalog videos: {e}")
        videos = existing
    
    # Try to seed interactions, but don't fail if this doesn't work
    try:
        seed_interactions(tokens, users, videos)
    except Exception as e:
        print(f"[demo-seeder] failed to seed interactions: {e}")
    
    print(f"[demo-seeder] completed with {len(videos)} videos available")


if __name__ == "__main__":
    main()
