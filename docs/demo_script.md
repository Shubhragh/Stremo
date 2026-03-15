# 7-Minute Demo Script

## Pre-demo setup (before judges join)
1. Run `docker compose up --build -d`.
2. Open:
   - Frontend: `http://localhost:3000`
   - MinIO console: `http://localhost:9001`
3. Confirm demo seeding completed:
   - `docker logs scalastream-demo-seeder`
4. Optional: trigger manual seed again (idempotent):
   - `docker compose run --rm demo-seeder`

## Live walkthrough
1. Show architecture diagram (`docs/architecture.md`) and explain async upload -> transcode queue.
2. Log in as User A.
3. Upload a new video and show immediate accepted response (`UPLOADED`).
4. Open status endpoint and show transition to `READY`.
5. Play a video from frontend:
   - Show quality selector (360p/720p).
   - Change playback speed.
6. Type search queries and show search history persistence.
7. Watch videos as User A and show watch history + retention metrics (`/videos/{id}/stats`).
8. Switch to User B and interact with different videos.
9. Trigger model retrain:
   - `curl -X POST http://localhost:8080/feed/train`
10. Open personalized feed for each user and show ranked differences + reason tags.
11. Run failure scenario:
    - `powershell -ExecutionPolicy Bypass -File scripts/failure_demo.ps1`
    - Explain consumer-group recovery and retry.

## What to emphasize to judges
- Queue decoupling and idempotent retries.
- Cost-aware storage/transcoding decisions.
- ML is behavior-driven from watch/engagement/search history, not static rule lists.
