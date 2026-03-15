# API Contracts

Base URL: `http://localhost:8080`

## Auth

### `POST /auth/register`
Request:
```json
{
  "email": "user@example.com",
  "password": "secret123"
}
```
Response includes:
- `token`
- `user`

### `POST /auth/login`
Request:
```json
{
  "email": "user@example.com",
  "password": "secret123"
}
```
Response includes:
- `token`
- `user`

### `GET /auth/me`
Returns current authenticated user profile for session bootstrap.

---

## Video APIs

### `GET /videos`
Returns READY videos with aggregate metadata.
Each item includes:
- `owner_id`
- `stream_url`
- `thumbnail_url`
- `liked_by_me`
- `can_delete` (true when requester is owner/admin)

### `GET /videos/search?q=&limit=&offset=`
Server-ranked search over title/description with stable relevance ordering.

### `POST /videos/upload` (auth required, `multipart/form-data`)
Fields:
- `title`
- `description`
- `file`

### `POST /videos/{id}/finalize` (auth required)
Requeues transcoding.

### `GET /videos/{id}/status`
Response includes:
- `status`
- `attempts`
- `last_error`
- `queue_ahead`
- `queue_total`
- `queue_position`
- `processing_video_id`

### `GET /videos/{id}`
Single video metadata.
Includes:
- `owner_id`
- `stream_url`
- `thumbnail_url`
- `liked_by_me`
- `can_delete`

### `DELETE /videos/{id}` (auth required)
Deletes video metadata + storage objects (raw + processed HLS assets).
Allowed for:
- owner
- admin

### `GET /videos/{id}/comments`
Recent comments.

### `GET /videos/{id}/stats`
Returns aggregate counters + retention metrics.
Example:
```json
{
  "like_count": 10,
  "comment_count": 4,
  "view_count": 23,
  "watch_time_total": 118.2,
  "sessions_started": 29,
  "avg_completion_rate": 0.64,
  "avg_watch_seconds": 5.72,
  "retention_25_rate": 0.93,
  "retention_50_rate": 0.72,
  "retention_75_rate": 0.48,
  "retention_95_rate": 0.22,
  "source": "redis"
}
```

### `POST /videos/{id}/like` (auth required)
```json
{ "liked": true, "video_id": "video-uuid" }
```

### `DELETE /videos/{id}/like` (auth required)
```json
{ "unliked": true, "video_id": "video-uuid" }
```

### `POST /videos/{id}/comment` (auth required)
Request:
```json
{ "comment": "Great video" }
```

### `POST /videos/{id}/view` (auth optional but recommended with auth)
Sessionized retention-aware view event.
Request:
```json
{
  "sessionId": "video-abc-session-1",
  "watchTimeSeconds": 3.2,
  "completionRate": 0.8,
  "durationSeconds": 4.0
}
```
Response includes `qualified_view`.

---

## User History APIs

### `GET /videos/history/watch` (auth required)
Returns recent watch sessions with progress.

### `GET /videos/history/search` (auth required)
Returns recent search queries.

### `POST /videos/history/search` (auth required)
Request:
```json
{ "query": "distributed streaming architecture" }
```

---

## Streaming API

### `GET http://<host>:8090/stream/{videoId}/master.m3u8`
Served by Nginx from processed HLS assets.

---

## Recommendation APIs

### `GET /feed/recommended?userId={userId}&limit=20`
Hybrid ML recommendation output with reason tags.

### `GET /feed/trending?limit=20`
Engagement-trending list.

### `GET /feed/fresh?limit=20`
Recency-focused list.

### `GET /feed/continue?userId={userId}&limit=20`
Continue-watching list.

### `POST /feed/train`
Forces retraining.

Example `recommended` response:
```json
{
  "user_id": "user-uuid",
  "limit": 20,
  "source": "hybrid_bpr_content",
  "trained_at": 1712345678.12,
  "training_summary": {
    "users": 12,
    "videos": 30,
    "interactions": 220,
    "search_events": 85,
    "mode": "hybrid_bpr_content"
  },
  "features": [
    "watch_time_ratio",
    "completion_rate",
    "like_flag",
    "comment_flag",
    "recency_weight",
    "search_embedding_signal",
    "hybrid_content_similarity"
  ],
  "items": [
    {
      "video_id": "video-uuid",
      "title": "Demo Clip",
      "score": 0.81,
      "reason": "ML blend of collaborative and content profile.",
      "reason_tags": ["balanced", "engaged"]
    }
  ]
}
```
