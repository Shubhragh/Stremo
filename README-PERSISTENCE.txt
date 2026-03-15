🎬 CRITICAL: Docker Persistence Guide

⚠️ IMPORTANT: Data Persistence in ThemeForge

The main issue users face is videos/data disappearing after Docker rebuild.
This is 100% preventable by using the correct Docker commands.

========================================
WRONG ❌ (Deletes Everything):
========================================
docker compose down -v
docker compose up -d --build

Result: 
- All videos DELETED
- All user accounts DELETED  
- All database records DELETED
- Starts completely fresh

========================================
CORRECT ✅ (Preserves Everything):
========================================
docker compose down
docker compose up -d --build

Result:
- All videos PRESERVED
- All user accounts PRESERVED
- All database records PRESERVED
- Continues where you left off

========================================
VOLUME ARCHITECTURE:
========================================

Docker Volumes (Persistent Storage):
├── postgres_data         → PostgreSQL database
│   ├── User accounts
│   ├── Video metadata
│   ├── Comments & likes
│   └── Watch history
│
├── minio_data           → S3 object storage  
│   ├── raw-videos/      → Uploaded video files
│   └── processed-videos/ → HLS streaming files
│
└── redis_data           → Cache & queue
    ├── Session data
    └── Event streams

These volumes SURVIVE:
✅ docker compose down
✅ docker compose restart
✅ Container crashes
✅ Host reboots

These volumes DO NOT SURVIVE:
❌ docker compose down -v   (explicitly deleted)
❌ docker volume rm *_data  (explicit deletion)
❌ docker system prune -a --volumes

========================================
The Three Scenarios:
========================================

SCENARIO 1: Rebuild with preserved data
$ docker compose down      # Stop containers
$ docker compose up -d --build  # Start with new code
Result: Videos and accounts are there ✅

SCENARIO 2: Test with fresh data
$ docker compose down -v   # Delete EVERYTHING
$ docker compose up -d --build  # Start fresh
Result: Demo accounts created, videos seeded 🆕

SCENARIO 3: Just restart containers
$ docker compose down
$ docker compose up -d     # Don't rebuild, just restart
Result: Everything is intact, runs fastest ⚡

========================================
Why Videos Don't Appear:
========================================

If you see "No ready videos yet":

1. First time setup?
   → Wait 1-2 minutes for demo seeder to finish
   → Check: docker logs scalastream-demo-seeder

2. Just did docker rebuild?
   → Did you use -v flag? DON'T!
   → Use: docker compose down (without -v)
   → Then: docker compose up -d --build

3. Demo videos not uploading?
   → Check transcode worker: 
      docker logs scalastream-transcode-worker
   → Check if sample.mp4 exists in /tmp folder
   → Videos take time to transcode (1-2 min per video)

4. Database corrupted?
   → Then use -v to start fresh:
      docker compose down -v
      docker compose up -d --build

========================================
Browser Session Persistence:
========================================

Your login is saved in browser localStorage:
✅ Survives browser refresh
✅ Survives browser restart
✅ Survives computer restart
✅ Survives Docker restarts
❌ Does NOT survive clearing browser cache
❌ Does NOT survive browser history clear

The database ALSO saves your account separately,
so even if browser clears data, database remembers you.

Login again if needed, database account is still there.

========================================
Video File Storage:
========================================

User uploads video:
  File → MinIO (raw-videos bucket)
              ↓
         Transcode Worker processes
              ↓
         MinIO (processed-videos bucket)
              ↓
         HLS files served by Nginx
              ↓
         Frontend player streams

All files stored in: minio_data volume

Database stores: Metadata, links, status

If minio_data volume deleted (-v flag):
  → All video files deleted
  → Database knows videos existed but files gone
  → Videos show status READY but won't stream

Solution: DON'T use -v unless starting completely fresh

========================================
For Development:
========================================

# Start development
docker compose down
docker compose up -d --build

# Code changes to frontend?
docker compose restart frontend

# Code changes to backend?
docker compose restart api-gateway

# Database migrations needed?
docker compose down
docker compose up -d --build

# Start completely fresh?
docker compose down -v
docker compose up -d --build

========================================
Common Commands:
========================================

Check if data is persisted:
  docker volume ls                    # See volumes
  docker volume inspect postgres_data # Check DB volume
  docker inspect scalastream-minio | grep Mounts  # Check MinIO

Check if videos exist:
  docker exec scalastream-postgres psql -U scalastream -d scalastream -c "SELECT COUNT(*) FROM videos;"
  docker exec scalastream-minio mc ls local/processed-videos/

Check accounts:
  docker exec scalastream-postgres psql -U scalastream -d scalastream -c "SELECT email FROM users;"

Watch logs during seeding:
  docker logs -f scalastream-demo-seeder

========================================
Summary:
========================================

❌ NEVER: docker compose down -v (unless starting fresh)
✅ ALWAYS: docker compose down (then up -d --build)

Your data is safe in Docker volumes.
Just don't use the -v flag!

========================================
