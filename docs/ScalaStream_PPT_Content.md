# ScalaStream PPT Content (Ready-to-Copy Slides)

Use this as direct slide text for a 10-12 slide final presentation.

---

## Slide 1: Title
**ScalaStream**  
Video Streaming Systems + Machine Learning  
Ingenium IIT Indore Submission

Team: ScalaStream  
Date: March 15, 2026

---

## Slide 2: Problem and Goal
- Build a scalable VOD platform.
- Support upload, transcoding, streaming, metadata, recommendations.
- Handle concurrent usage and failures.
- Deliver judge-friendly local demo.

---

## Slide 3: Scope and Assumptions
- Live streaming: out of scope.
- Real-world internet scale: not mandatory.
- Synthetic/mock data: allowed.
- Horizontal scaling: must be conceptually supported.

How we aligned:
- VOD architecture only.
- Local Dockerized deployment.
- Demo seeder for realistic interactions.
- Stateless services + worker scaling path.

---

## Slide 4: System Architecture
Components:
- Frontend
- API Gateway/Auth
- Video Service
- Transcode Worker
- Recommendation Service
- PostgreSQL, Redis, MinIO, Nginx

Flow:
Upload -> Queue -> Transcode -> HLS -> Watch  
Interactions -> DB -> Model Training -> Personalized Feed

---

## Slide 5: Functional Requirements Coverage
- Auth and authorization: implemented.
- Upload: implemented.
- Transcoding to HLS: implemented.
- Playback: implemented.
- Metadata (likes/comments/views): implemented.
- ML recommendation feed: implemented.
- Concurrent uploads: implemented.

---

## Slide 6: Non-Functional Strategy
- Low latency: HLS via stream gateway.
- Fault tolerance: async queue + retries + recovery.
- Cost efficiency: 360p/720p ladder + local infra.
- Scalability: stateless APIs + scalable workers.
- Graceful failure: status APIs + retry/finalize.

---

## Slide 7: ML Recommendation (Simple Explanation)
Why ML:
- Static rules cannot adapt to user taste changes.

Signals used:
- Watch depth/completion
- Likes/comments
- Search history
- Video text features

Approach:
- Collaborative embeddings (BPR matrix factorization)
- Content profile modeling
- Logistic blend calibration (learned score weights)

---

## Slide 8: Why It Is Not Rule-Based
- Trained parameters, not fixed ordering.
- Model retrains from new behavior.
- Different users receive different ranked feeds.
- Training diagnostics available (AUC/logloss/learned blend weights).

---

## Slide 9: Optional Features Implemented
- Adaptive quality selection.
- Playback speed control.
- Multiple recommendation rails:
  - For You
  - Trending
  - Fresh
  - Continue Watching

---

## Slide 10: Scalability + Cost Tradeoffs
- Redis chosen for queue+cache simplicity.
- MinIO for storage decoupling.
- Scheduled retraining for lower compute cost.
- Hybrid recommender selected for quality vs local compute balance.

---

## Slide 11: Demo Plan (7 Minutes)
1. Login/register.
2. Upload video.
3. Show processing status.
4. Play watch page video.
5. Like/comment/view updates.
6. Show For You and Trending.
7. Retrain and show recommendation update.

---

## Slide 12: Submission Deliverables
- Working web app (upload, playback, metadata)
- Architecture diagram
- Scalability and cost strategy
- ML recommendation explanation
- Source repo with README

Conclusion:
ScalaStream delivers complete end-to-end functionality and a genuine ML-powered personalized recommendation pipeline.

