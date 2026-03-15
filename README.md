# ScalaStream

ScalaStream is a Dockerized VOD streaming platform for the Ingenium IIT Indore Video Streaming Systems competition.

It includes:
- Upload + async transcoding to HLS
- Low-latency HLS playback
- Likes/comments/views with retention-aware view logic
- Persistent watch history + search history
- ML recommendation engine (hybrid collaborative + content + search profile)
- Judge-friendly auto-seeded demo data

## Competition Compliance Snapshot
- Full requirement-by-requirement mapping:
  - `docs/competition_compliance_matrix.md`
- Architecture diagram and data flow:
  - `docs/architecture.md`
- Scalability and cost strategy:
  - `docs/scaling_cost_tradeoffs.md`
- AI/ML explanation (why ML, data used, UX impact):
  - `docs/ml_recommendation_approach.md`

## Architecture
- `frontend` (`:3000`)
- `api-gateway` (`:8080`) auth + routing
- `video-service` (`:8081`) upload, metadata, view/retention logic, history APIs
- `transcode-worker` async FFmpeg transcoding
- `recommendation-service` (`:8082`) model training + ranking APIs
- `stream-gateway` (`:8090`) HLS serving from MinIO
- `postgres`, `redis`, `minio`
- `demo-seeder` (one-shot, auto-populates demo users/videos/interactions)

## Quick Start (Judge Friendly)
1. From project root:
   ```powershell
   docker compose up -d --build
   ```
2. Open:
   - `http://localhost:3000`
3. Demo data is auto-seeded only when the library is empty (bootstrap behavior) by `demo-seeder`, with a mixed-topic catalog and interactions for recommendation proof.
4. First boot can take 3-8 minutes depending on system speed (image build + transcoding).

## Demo Accounts
- `demo_creator@scalastream.local` / `pass1234`
- `demo_viewer@scalastream.local` / `pass1234`

These accounts are auto-created by the demo seeder and are useful for showing different recommendation behavior.

## Persistence
Data persists across container restarts using Docker named volumes:
- `postgres_data`
- `minio_data`
- `redis_data`

Important:
- `docker compose down` keeps data.
- `docker compose down -v` deletes all persisted data.

If your friend opens the app on your host machine URL (same LAN), both of you see the same videos/metadata.
If your friend runs a separate copy on their own laptop, that is a separate database by design.

## Multi-Device Access (Same LAN)
1. Run ScalaStream on host machine.
2. Find host LAN IP (example: `192.168.1.50`).
3. Open from another device:
   - `http://192.168.1.50:3000`

Frontend auto-resolves API/stream host from request host, so it works for LAN clients.

## Judge Independent Run
This project is designed so judges can run it independently and still get a working demo:
1. Clone/unzip repository.
2. Run:
   ```powershell
   docker compose up -d --build
   ```
3. Wait until services are healthy, then open `http://localhost:3000`.
4. Demo videos + interactions are auto-seeded even on a clean machine.
5. Optional retrain:
   ```powershell
   curl -X POST http://localhost:8080/feed/train
   ```

## Core APIs
- Auth:
  - `POST /auth/register`
  - `POST /auth/login`
  - `GET /auth/me`
- Video:
  - `GET /videos`
  - `GET /videos/search?q=&limit=&offset=`
  - `POST /videos/upload`
  - `GET /videos/{id}`
  - `GET /videos/{id}/status`
  - `POST /videos/{id}/finalize`
  - `DELETE /videos/{id}`
  - `POST /videos/{id}/like`
  - `DELETE /videos/{id}/like`
  - `POST /videos/{id}/comment`
  - `POST /videos/{id}/view`
  - `GET /videos/{id}/comments`
  - `GET /videos/{id}/stats` (includes retention metrics)
- User history:
  - `GET /videos/history/watch`
  - `GET /videos/history/search`
  - `POST /videos/history/search`
- Recommendations:
  - `GET /feed/recommended?userId=...&limit=...`
  - `GET /feed/trending?limit=...`
  - `GET /feed/fresh?limit=...`
  - `GET /feed/continue?userId=...&limit=...`
  - `POST /feed/train`
- Internal:
  - `POST /internal/client-log` (optional frontend diagnostics hook)

## View/Retention Logic
View counting is sessionized and quality-aware:
- Events carry `sessionId`, `watchTimeSeconds`, `completionRate`, `durationSeconds`.
- Only qualified sessions increment `view_count` (not every ping).
- Watch time is delta-based (avoids overcounting).
- Retention metrics are derived from session completion progression and exposed via `/videos/{id}/stats`.

## ML Recommendation Approach
The recommender is ML-based and uses:
- Watch history signals
- Likes + comments engagement
- Search history embeddings
- Video text embeddings (title/description)

Model behavior:
- Collaborative latent factors (BPR-style training)
- Content embeddings for item/user profiles
- Supervised logistic calibration learns blend weights for final ranking
- Cold-start uses learned global priors + live search/content profile (not static rule lists)

## Optional Enhancements Implemented
- Adaptive quality selection (`Auto`, `360p`, `720p`)
- Playback speed control (`0.75x`, `1x`, `1.25x`, `1.5x`, `2x`)
- Enhanced recommendation filters (`For You`, `Trending`, `Fresh`, `Continue Watching`)

## Demo Script (7 min)
1. Open frontend and log in with a new user.
2. Search via top search bar (button or Enter), then open a video card.
3. Confirm watch page route `/watch/{videoId}` opens with large player.
4. Show quality/speed/autoplay controls and keyboard shortcuts.
5. Like/comment and verify per-user like state (`liked_by_me` behavior).
6. Show watch history + search history updates.
7. Retrain and show recommendation changes by user behavior.

## Operational Commands
Start:
```powershell
docker compose up -d --build
```

Stop (keep data):
```powershell
docker compose down
```

Hard reset (delete all data):
```powershell
docker compose down -v
```

Re-seed manually:
```powershell
docker compose run --rm demo-seeder
```

Generate live demo-user activity + retrain recommendations:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/demo_activity_burst.ps1
```

Concurrent upload stress test (20 parallel uploads):
```powershell
# Requires k6 installed locally
k6 run -e TOKEN=<jwt_token> -e BASE_URL=http://localhost:8080 -e FILE_PATH=./tmp/sample.mp4 scripts/upload_concurrency_test.js
```

Failure recovery demo:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/failure_demo.ps1
```

Scale transcode workers horizontally:
```powershell
docker compose up -d --scale transcode-worker=3
```

Create submission zip:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/package_submission.ps1
```

## Submission Checklist
- Source code with `docker-compose.yml`
- README (this file)
- Architecture diagram (`docs/architecture.md`)
- Scalability/cost tradeoffs (`docs/scaling_cost_tradeoffs.md`)
- ML recommendation approach (`docs/ml_recommendation_approach.md`)
- Compliance matrix (`docs/competition_compliance_matrix.md`)
- API contracts (`docs/api_contracts.md`)
- Demo script (`docs/demo_script.md`)

## Scope and Assumptions
- VOD only; live streaming is intentionally out of scope.
- Local Docker deployment is used for judging; architecture still supports conceptual horizontal scalability.
- Synthetic/mock interaction data is supported for deterministic demos.
