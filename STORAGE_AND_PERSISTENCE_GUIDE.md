# 🔧 Storage & Persistence Guide - ThemeForge

## 🎯 Problem: Videos Disappearing After Docker Rebuild

### ❌ What NOT to Do
```bash
# DANGER: This removes ALL data including uploaded videos!
docker compose down -v
```

The `-v` flag **deletes all volumes**, which includes:
- ✗ All uploaded videos (MinIO storage)
- ✗ All database records (PostgreSQL)
- ✗ User accounts and login info
- ✗ Redis cache
- ✗ Everything else!

### ✅ What to Do Instead

#### Option 1: Preserve All Data (RECOMMENDED)
```bash
# Stop containers but KEEP all data
docker compose down

# Rebuild and restart with all data intact
docker compose up -d --build
```
**Result**: All videos, users, and data remain!

#### Option 2: Clean Rebuild When Needed
```bash
# Only use -v when you INTENTIONALLY want to delete everything
docker compose down -v

# This wipes the slate clean - use for testing, not production
docker compose up -d --build
```

---

## 📦 Storage Architecture

### What's Being Persisted?

```
ThemeForge Storage System
├── PostgreSQL Database (postgres_data)
│   ├── Users & Accounts
│   ├── Video Metadata
│   ├── Comments
│   ├── Likes
│   └── Watch History
│
├── MinIO S3 Storage (minio_data)
│   ├── Raw Videos (raw-videos bucket)
│   │   └── Original uploads
│   └── Processed Videos (processed-videos bucket)
│       └── HLS streaming files
│           ├── master.m3u8
│           ├── variant playlists
│           ├── .ts segments
│           └── thumbnails
│
└── Redis Cache (redis_data)
    ├── Session data
    ├── Temporary queue
    └── Analytics counters
```

### Docker Volumes in docker-compose.yml

```yaml
volumes:
  postgres_data:      # Database persistence
  redis_data:         # Cache persistence  
  minio_data:         # Video files persistence
```

**These volumes are NAMED volumes** - they persist even when containers stop, unless explicitly deleted with `-v`.

---

## 🔐 Login Credentials Persistence

### How It Works

**Frontend (Browser)**:
```javascript
// Stored in browser localStorage (automatically)
localStorage.setItem("scalastream_token", token);
localStorage.setItem("scalastream_user", JSON.stringify(user));
```

**Backend (Server)**:
```
Database (PostgreSQL)
    ├── Stores user email & password hash
    ├── Issues JWT token on login
    └── Token valid for session
```

### Why You Need to Login Again After Docker Rebuild

#### Scenario 1: `docker compose down` (without -v)
```
✅ Database SURVIVES - your account is still there
✅ Browser localStorage SURVIVES - token is cached
✅ Result: You should NOT need to login again!
```

**What to check**:
1. Open browser Developer Tools: **F12**
2. Go to **Application > Local Storage**
3. Look for `scalastream_token` and `scalastream_user`
4. If they exist, page should auto-login on refresh

#### Scenario 2: `docker compose down -v` (with -v)
```
✗ Database DELETED - your account is gone
✓ Browser localStorage SURVIVES - but token is invalid
✗ Result: Need to recreate account (login fails because user doesn't exist)
```

### Solution: Don't Use `-v` Flag!

**Use this workflow**:
```bash
# Development: Preserve everything
docker compose down
docker compose up -d --build

# Testing/Demo: Clean slate (intentional)
docker compose down -v
docker compose up -d --build
```

---

## 🎥 Video Persistence Deep Dive

### Where Are Videos Stored?

**MinIO (S3-Compatible Object Storage)**:
```
MinIO Container
    └── /data/ (mounted as minio_data volume)
        ├── raw-videos/
        │   ├── video-1-uuid.mp4
        │   ├── video-2-uuid.mkv
        │   └── ...
        └── processed-videos/
            ├── video-1-uuid/
            │   ├── master.m3u8 (HLS playlist)
            │   ├── stream_0.m3u8
            │   ├── stream_1.m3u8
            │   ├── stream_0_00001.ts
            │   ├── stream_0_00002.ts
            │   └── thumbnail.jpg
            └── video-2-uuid/
                └── ...
```

### How Video Processing Works

```
User Uploads Video
        ↓
1. FrontEnd → Send file to API
        ↓
2. API Gateway → Authenticates user
        ↓
3. Video Service → Creates DB record, saves to MinIO (raw-videos)
        ↓
4. Returns video_id to frontend (still processing)
        ↓
5. Transcode Worker picks up → Converts to HLS format
        ↓
6. Saves processed segments → MinIO (processed-videos)
        ↓
7. Updates DB status → "READY" (now visible to stream)
        ↓
Stream Gateway (Nginx) → Serves HLS files from MinIO
        ↓
Frontend Player → Requests segments, rebuilds video
```

### Why Videos Disappear

| Scenario | Database | MinIO Videos | Result |
|----------|----------|--------------|--------|
| `down` | ✅ Stays | ✅ Stays | Videos appear |
| `down -v` | ✗ Deleted | ✗ Deleted | Videos gone |
| Container crash | ✅ Stays | ✅ Stays | Videos survive |
| Host restart | ✅ Stays | ✅ Stays | Videos survive |

---

## 📱 Browser Storage (Local Session Persistence)

### What's Stored in Browser?

**localStorage** (permanent until cleared):
```javascript
scalastream_token      // JWT auth token
scalastream_user       // User email + ID
scalastream_autoplay   // Video autoplay preference
```

**sessionStorage** (cleared on browser close):
- Currently not used, but available for future

### How to Check Your Stored Data

**Chrome/Edge/Firefox**:
1. Press **F12** to open Developer Tools
2. Go to **Application** tab
3. Select **Local Storage**
4. Click `http://localhost:3000`
5. You'll see all stored values

### How to Clear Browser Data (If Needed)

```javascript
// Clear all ScalaStream data
localStorage.removeItem("scalastream_token");
localStorage.removeItem("scalastream_user");
localStorage.removeItem("scalastream_autoplay");

// Or clear everything
localStorage.clear();
```

Or use browser settings:
1. Press **Ctrl+Shift+Del** (Windows) or **Cmd+Shift+Del** (Mac)
2. Select "Cookies and other site data"
3. Clear

---

## 🎯 Best Practices

### For Development

```bash
# 1. Start fresh (preserve data)
docker compose down
docker compose up -d --build

# 2. Test new features (keep existing data)
docker compose restart api-gateway

# 3. Test with fresh data (delete everything)
docker compose down -v
docker compose up -d --build
```

### For Production-Like Testing

```bash
# Keep database and video storage
docker compose down

# Just pull latest images
docker pull scalastream-api-gateway:latest

# Restart with new images
docker compose up -d
```

### Backup Videos (If Needed)

```bash
# Copy MinIO data to local disk
docker cp scalastream-minio:/data/processed-videos ./backup-videos

# Copy database
docker exec scalastream-postgres pg_dump -U scalastream -d scalastream > backup-db.sql
```

---

## 🐛 Troubleshooting

### Problem: "Videos disappeared after rebuild"
**Solution**: 
- You likely used `docker compose down -v`
- Use `docker compose down` (without -v) next time
- To restore: Check if you have backups, or re-upload

### Problem: "I see old videos but not new ones I just uploaded"
**Possible Causes**:
1. Video is still processing (check status)
2. Server error during upload
3. Storage is full

**Solution**:
```bash
# Check transcode worker logs
docker logs scalastream-transcode-worker

# Check if video exists
docker exec scalastream-minio mc ls local/raw-videos/

# Check MinIO storage usage
docker logs scalastream-minio
```

### Problem: "Login doesn't work after browser refresh"
**Possible Causes**:
1. localStorage was cleared
2. Server session expired
3. Token invalid

**Solution**:
1. Clear browser data: Ctrl+Shift+Del
2. Try logging in again
3. If still fails, restart Docker: `docker compose restart api-gateway`

### Problem: "Can't upload videos - permission denied"
**Solution**:
1. Make sure you're logged in (see "Sign In" button)
2. Check user account exists in database:
```bash
docker exec scalastream-postgres psql -U scalastream -d scalastream -c "SELECT id, email FROM users;"
```

### Problem: "Videos show for me but not for other users"
**Solution**:
1. Check video status is "READY":
```bash
docker exec scalastream-postgres psql -U scalastream -d scalastream -c "SELECT id, status FROM videos;"
```

2. Videos should be visible to everyone if `status = 'READY'`

---

## 🔄 Complete Workflow Example

### Scenario: Development with Persistent Data

```bash
# Day 1: Start fresh
docker compose down -v  # Fresh start
docker compose up -d --build

# Upload some test videos
# Create some test accounts
# Everything is saved to minio_data, postgres_data, redis_data volumes

# Day 2: Continue development
# Just want to rebuild frontend with new code
docker compose down     # Stop everything but keep data!
docker compose up -d --build  # Restart - all videos and accounts are there!

# Day 3: Need to test something with fresh data
docker compose down -v  # Now delete everything
docker compose up -d --build --build  # Start completely fresh

# Day 4: Set up for demo
# All videos and users preserved from Day 2
docker compose down
docker compose up -d
# Demo works perfectly - all data intact!
```

---

## 📊 Storage Limits & Performance

### Storage Capacity
- **MinIO**: Limited by disk space (default: unlimited on dev machine)
- **PostgreSQL**: Limited by disk space
- **Redis**: Limited by RAM (development container)

### Recommended Specs

| Metric | Development | Testing | Production |
|--------|-------------|---------|------------|
| Videos | 10-20 | 50-100 | 1000+ |
| Storage | 50GB | 200GB | 1-5TB |
| RAM | 4GB | 8GB | 32GB+ |
| Cores | 2 | 4 | 8+ |

### Cleanup Commands

```bash
# Remove old video segments (if disk is full)
docker exec scalastream-minio mc rm --recursive --force local/processed-videos/old-video-id

# Vacuum database
docker exec scalastream-postgres psql -U scalastream -d scalastream -c "VACUUM ANALYZE;"

# Check disk usage
docker system df
```

---

## 🔗 Architecture References

**See also**:
- `/docs/architecture.md` - System design
- `/infra/nginx/nginx.conf` - Stream gateway config
- `/services/video-service/src/storage.js` - File upload logic
- `/services/transcode-worker/src/worker.py` - Video processing

---

## 📞 Quick Reference

```bash
# Common Commands
docker compose up -d                 # Start everything
docker compose down                  # Stop (keep data)
docker compose down -v               # Stop (delete all data)
docker compose logs -f api-gateway   # Watch API logs
docker compose ps                    # See running services
docker exec -it scalastream-postgres psql -U scalastream -d scalastream

# Volume Management
docker volume ls                      # List all volumes
docker volume inspect postgres_data   # See volume details
docker volume rm postgres_data        # Delete a volume (WARNING!)

# Check Stored Data
docker exec scalastream-postgres psql -U scalastream -d scalastream -c "SELECT COUNT(*) FROM videos;"
docker exec scalastream-minio mc ls local/processed-videos/
```

---

**Remember**: 
- ✅ Use `docker compose down` for normal stops
- ❌ Use `docker compose down -v` only when you want to DELETE everything
- 🎯 All data is persistent unless you use the `-v` flag

Your videos and accounts are safe! 🎬

