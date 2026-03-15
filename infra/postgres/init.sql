CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'video_status') THEN
        CREATE TYPE video_status AS ENUM ('UPLOADED', 'PROCESSING', 'READY', 'FAILED');
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS videos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    raw_object_key TEXT NOT NULL,
    processed_prefix TEXT,
    duration_seconds REAL NOT NULL DEFAULT 0,
    status video_status NOT NULL DEFAULT 'UPLOADED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_videos_status_created_at ON videos(status, created_at DESC);

CREATE TABLE IF NOT EXISTS video_likes (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, video_id)
);

CREATE TABLE IF NOT EXISTS video_comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    comment_text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_comments_video_created_at ON video_comments(video_id, created_at DESC);

CREATE TABLE IF NOT EXISTS video_views (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    session_id TEXT,
    watch_time_seconds REAL NOT NULL DEFAULT 0,
    watch_delta_seconds REAL NOT NULL DEFAULT 0,
    completion_rate REAL NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_views_video_created_at ON video_views(video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_views_user_video ON video_views(user_id, video_id);
CREATE INDEX IF NOT EXISTS idx_video_views_session ON video_views(video_id, session_id);

CREATE TABLE IF NOT EXISTS video_watch_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id TEXT NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_watch_seconds REAL NOT NULL DEFAULT 0,
    max_watch_seconds REAL NOT NULL DEFAULT 0,
    completion_rate_max REAL NOT NULL DEFAULT 0,
    duration_seconds_hint REAL NOT NULL DEFAULT 0,
    counted_view BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (video_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_watch_sessions_video ON video_watch_sessions(video_id, last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_watch_sessions_user ON video_watch_sessions(user_id, last_event_at DESC);

CREATE TABLE IF NOT EXISTS user_search_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query_text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_search_events_user_created_at ON user_search_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS video_aggregates (
    video_id UUID PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
    like_count INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 0,
    watch_time_total REAL NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transcode_jobs (
    video_id UUID PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_attempt_at TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_videos_touch_updated_at ON videos;
CREATE TRIGGER trg_videos_touch_updated_at
BEFORE UPDATE ON videos
FOR EACH ROW EXECUTE PROCEDURE touch_updated_at();

DROP TRIGGER IF EXISTS trg_video_views_touch_updated_at ON video_views;
CREATE TRIGGER trg_video_views_touch_updated_at
BEFORE UPDATE ON video_views
FOR EACH ROW EXECUTE PROCEDURE touch_updated_at();
