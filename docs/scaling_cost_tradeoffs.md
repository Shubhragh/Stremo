# Scalability and Cost Tradeoffs

## Why this architecture scales
- Stateless API services (`api-gateway`, `video-service`, `recommendation-service`) can scale horizontally.
- Redis Streams decouple upload ingest from CPU-heavy transcoding.
- MinIO object storage separates storage growth from compute nodes.
- PostgreSQL handles transactional metadata with indexes on hot read/write paths.
- Sessionized view tracking (`video_watch_sessions`) allows retention analytics without expensive per-request joins.

## Cost-efficient choices for student setup
- Local Docker Compose avoids cloud spend while preserving production-like service boundaries.
- Redis is used as both queue and cache to avoid adding another broker in v1.
- HLS segmenting uses two renditions (360p, 720p) to balance quality and storage costs.
- Recommendation training runs on schedule, not every request, reducing compute load.
- Demo seeding is one-shot and idempotent, so judges get deterministic startup without paid infrastructure.

## Tradeoffs and rationale
- Redis Streams vs Kafka:
  - Chosen Redis for setup speed and lower operational overhead.
  - Accepts lower retention/throughput headroom compared to Kafka.
- PostgreSQL counters + Redis cache:
  - Chosen for correctness-first writes and low-latency reads.
  - Requires periodic reconciliation in larger deployments.
- Hybrid collaborative + content embeddings vs deep sequence transformers:
  - Chosen for fast local training and better cold-start behavior using search/watch content.
  - Accepts lower long-horizon sequence modeling quality than transformer recommenders.

## Horizontal scale path (conceptual)
- Add API replicas behind a load balancer.
- Add multiple transcode workers in same consumer group.
- Split read replicas for recommendations.
- Move MinIO to distributed mode or managed object storage in cloud deployment.
- Externalize model store (shared object storage) and use async retrain jobs for larger clusters.

## Non-Functional Requirement Coverage
- Low-latency delivery:
  - HLS segments are served through Nginx gateway with cache-friendly headers.
  - Metadata reads use Redis hot counters to reduce DB latency on hot paths.
- High availability and fault tolerance:
  - Upload ingest and transcode execution are decoupled via queue semantics.
  - Worker restarts recover from pending messages and continue processing.
  - Failure demo script (`scripts/failure_demo.ps1`) provides reproducible recovery proof.
- Cost-efficient storage and network:
  - Two-rendition ladder (`360p`, `720p`) avoids unnecessary storage/egress multiplication.
  - HLS segmenting allows adaptive playback without re-uploading alternate files.
  - MinIO object storage separates cheap durable storage from compute containers.
- Scalable architecture:
  - Stateless services can be replicated independently.
  - Workers scale horizontally with shared stream group and unique consumer identities.
- Graceful failure handling:
  - Upload queue state remains visible in UI.
  - Retry/finalize controls are available for failed transcodes.
  - Health banner communicates degraded upstreams.

## Tradeoff Justification Summary
- Single broker choice:
  - Using Redis for queue + cache keeps ops simple and low-cost.
  - Tradeoff is less enterprise replay/control than Kafka.
- Relational metadata choice:
  - PostgreSQL gives strong consistency for likes/comments/views/auth.
  - Tradeoff is write scaling complexity at very large internet scale.
- Hybrid recommender choice:
  - BPR + content/profile blending gives strong personalization with cold-start support on limited hardware.
  - Tradeoff is less sequence awareness than transformer-based recommenders.
- Local-first deployment choice:
  - Docker Compose ensures judges can run independently with zero cloud spend.
  - Tradeoff is no built-in multi-region availability in this competition build.
