require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const cors = require("cors");
const express = require("express");
const jwt = require("jsonwebtoken");
const morgan = require("morgan");
const multer = require("multer");

const config = require("./config");
const { pool, query } = require("./db");
const { redis, connectRedis } = require("./redisClient");
const { uploadFile, deleteFile, deleteObjectsWithPrefix } = require("./storage");
const { publishEvent } = require("./events");

const app = express();
const uploadTmpDir = "/tmp/scalastream-uploads";
const jwtSecret = process.env.JWT_SECRET || "scalastream-super-secret";
const adminEmailSet = new Set((config.adminEmails || []).map((email) => String(email).toLowerCase()));
const adminWildcard = adminEmailSet.has("*");

const upload = multer({
  dest: uploadTmpDir,
  limits: { fileSize: config.maxUploadSizeMb * 1024 * 1024 },
});

app.use(cors({ origin: "*", credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

function requireUser(req, res, next) {
  const user = resolveUserFromHeaders(req);
  if (!user?.id) {
    return res.status(401).json({ error: "authentication required" });
  }

  req.user = user;
  return next();
}

function parseBearer(authHeader) {
  if (!authHeader || !String(authHeader).startsWith("Bearer ")) {
    return null;
  }
  return String(authHeader).slice("Bearer ".length).trim();
}

function resolveUserFromHeaders(req) {
  const headerUserId = String(req.headers["x-user-id"] || "").trim();
  if (headerUserId) {
    return {
      id: headerUserId,
      email: String(req.headers["x-user-email"] || ""),
    };
  }

  const token = parseBearer(req.headers.authorization);
  if (!token) {
    return null;
  }

  try {
    const payload = jwt.verify(token, jwtSecret);
    if (!payload?.sub) {
      return null;
    }
    return {
      id: String(payload.sub),
      email: String(payload.email || ""),
    };
  } catch (_error) {
    return null;
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toFloat(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function streamUrl(videoId) {
  return `${config.streamBaseUrl}/${videoId}/master.m3u8`;
}

function thumbnailUrl(videoId) {
  return `${config.streamBaseUrl}/${videoId}/thumbnail.jpg`;
}

function isAdminUser(user) {
  const email = String(user?.email || "").trim().toLowerCase();
  if (!email) {
    return false;
  }
  return adminWildcard || adminEmailSet.has(email);
}

function normalizeSearchQuery(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, config.maxSearchQueryLength);
}

function safeTextArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return [];
}

function normalizeSpace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function withFallbackEnrichment(row) {
  const semanticText = normalizeSpace(`${row.title || ""} ${row.description || ""}`);
  return {
    ...row,
    generated_description: "",
    search_tags: [],
    audio_labels: [],
    visual_labels: [],
    content_category: "",
    semantic_text: semanticText,
  };
}

function sanitizeComment(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, config.maxCommentLength);
}

function ensureSessionId(rawSessionId, userId, videoId, req) {
  const cleaned = String(rawSessionId || "")
    .replace(/[^\w\-:.]/g, "")
    .slice(0, 120);
  if (cleaned) {
    return cleaned;
  }
  if (userId) {
    return `u:${userId}:${videoId}`;
  }
  const anonSeed = String(req.headers["x-forwarded-for"] || req.ip || "anon")
    .replace(/[^\w\-:.]/g, "")
    .slice(0, 64);
  return `a:${anonSeed}:${videoId}`;
}

async function incrementAuditCounter(name, amount = 1) {
  if (!name || !Number.isFinite(amount) || amount === 0) {
    return;
  }
  await redis.hIncrBy("audit:video_service", name, Number(amount));
  await redis.expire("audit:video_service", 7 * 24 * 60 * 60);
}

async function isLikelyVideoUpload(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return false;
    }

    const header = buffer.subarray(0, bytesRead);
    const trimmedLower = header.toString("utf8").trimStart().toLowerCase();
    if (trimmedLower.startsWith("<!doctype html") || trimmedLower.startsWith("<html")) {
      return false;
    }
    return true;
  } finally {
    await handle.close();
  }
}

async function incrementCache(videoId, { likes = 0, comments = 0, views = 0, watchTime = 0 }) {
  const key = `video:${videoId}:counts`;
  if (likes) {
    await redis.hIncrBy(key, "like_count", likes);
  }
  if (comments) {
    await redis.hIncrBy(key, "comment_count", comments);
  }
  if (views) {
    await redis.hIncrBy(key, "view_count", views);
  }
  if (watchTime) {
    await redis.hIncrByFloat(key, "watch_time_total", watchTime);
  }
  await redis.expire(key, 3600);
}

async function updateAggregate(client, videoId, delta = {}) {
  const likes = Number(delta.likes || 0);
  const comments = Number(delta.comments || 0);
  const views = Number(delta.views || 0);
  const watchTime = Number(delta.watchTime || 0);

  await client.query(
    `
      INSERT INTO video_aggregates (
        video_id, like_count, comment_count, view_count, watch_time_total, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (video_id) DO UPDATE SET
        like_count = video_aggregates.like_count + EXCLUDED.like_count,
        comment_count = video_aggregates.comment_count + EXCLUDED.comment_count,
        view_count = video_aggregates.view_count + EXCLUDED.view_count,
        watch_time_total = video_aggregates.watch_time_total + EXCLUDED.watch_time_total,
        updated_at = NOW()
    `,
    [videoId, likes, comments, views, watchTime]
  );
}

async function readRetention(videoId) {
  const result = await query(
    `
      SELECT
        COUNT(*)::int AS sessions_started,
        AVG(completion_rate_max) AS avg_completion_rate,
        AVG(max_watch_seconds) AS avg_watch_seconds,
        SUM(CASE WHEN completion_rate_max >= 0.25 THEN 1 ELSE 0 END)::int AS r25_count,
        SUM(CASE WHEN completion_rate_max >= 0.50 THEN 1 ELSE 0 END)::int AS r50_count,
        SUM(CASE WHEN completion_rate_max >= 0.75 THEN 1 ELSE 0 END)::int AS r75_count,
        SUM(CASE WHEN completion_rate_max >= 0.95 THEN 1 ELSE 0 END)::int AS r95_count
      FROM video_watch_sessions
      WHERE video_id = $1
    `,
    [videoId]
  );

  const row = result.rows[0] || {};
  const started = Number(row.sessions_started || 0);
  const toRate = (count) => (started > 0 ? Number(count || 0) / started : 0);

  return {
    sessions_started: started,
    avg_completion_rate: Number(row.avg_completion_rate || 0),
    avg_watch_seconds: Number(row.avg_watch_seconds || 0),
    retention_25_rate: toRate(row.r25_count),
    retention_50_rate: toRate(row.r50_count),
    retention_75_rate: toRate(row.r75_count),
    retention_95_rate: toRate(row.r95_count),
  };
}

async function readStats(videoId) {
  const cache = await redis.hGetAll(`video:${videoId}:counts`);
  const hasCache = Object.keys(cache).length > 0;
  const retention = await readRetention(videoId);

  if (hasCache) {
    return {
      like_count: Number(cache.like_count || 0),
      comment_count: Number(cache.comment_count || 0),
      view_count: Number(cache.view_count || 0),
      watch_time_total: Number(cache.watch_time_total || 0),
      ...retention,
      source: "redis",
    };
  }

  const result = await query(
    `
      SELECT
        COALESCE(like_count, 0) AS like_count,
        COALESCE(comment_count, 0) AS comment_count,
        COALESCE(view_count, 0) AS view_count,
        COALESCE(watch_time_total, 0) AS watch_time_total
      FROM video_aggregates
      WHERE video_id = $1
    `,
    [videoId]
  );

  if (result.rowCount === 0) {
    return {
      like_count: 0,
      comment_count: 0,
      view_count: 0,
      watch_time_total: 0,
      ...retention,
      source: "db",
    };
  }

  return { ...result.rows[0], ...retention, source: "db" };
}

app.get("/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    await redis.ping();
    res.json({ ok: true, service: "video-service" });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/internal/client-log", async (req, res) => {
  const level = String(req.body.level || "info").toLowerCase();
  const message = String(req.body.message || "client-log").slice(0, 500);
  const details = String(req.body.details || "").slice(0, 1000);
  const route = String(req.body.route || "").slice(0, 200);
  const user = resolveUserFromHeaders(req);
  const prefix = `[client-log:${level}]`;
  const text = `${prefix} user=${user?.id || "anonymous"} route=${route} msg=${message} details=${details}`;

  if (level === "error" || level === "warn" || level === "warning") {
    console.warn(text);
  } else {
    console.log(text);
  }

  try {
    if (!user?.id) {
      await incrementAuditCounter("client_log_anonymous");
    }
  } catch (_error) {
    // Do not fail log endpoint because of audit metrics.
  }

  return res.status(202).json({ ok: true });
});

app.get("/videos", async (req, res) => {
  const limit = clamp(Number(req.query.limit || 20), 1, 50);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const user = resolveUserFromHeaders(req);
  const userId = user?.id || null;
  const isAdmin = isAdminUser(user);

  try {
    const result = await query(
      `
        SELECT
          v.id,
          v.owner_id,
          v.title,
          v.description,
          v.status,
          v.created_at,
          v.duration_seconds,
          COALESCE(a.like_count, 0) AS like_count,
          COALESCE(a.comment_count, 0) AS comment_count,
          COALESCE(a.view_count, 0) AS view_count,
          COALESCE(a.watch_time_total, 0) AS watch_time_total,
          ''::TEXT AS generated_description,
          ARRAY[]::TEXT[] AS search_tags,
          ARRAY[]::TEXT[] AS audio_labels,
          ARRAY[]::TEXT[] AS visual_labels,
          ''::TEXT AS content_category,
          ''::TEXT AS semantic_text,
          CASE
            WHEN $3::uuid IS NULL THEN FALSE
            ELSE l.user_id IS NOT NULL
          END AS liked_by_me
        FROM videos v
        LEFT JOIN video_aggregates a ON a.video_id = v.id
        LEFT JOIN video_likes l ON l.video_id = v.id AND l.user_id = $3::uuid
        WHERE v.status = 'READY'
        ORDER BY v.created_at DESC
        LIMIT $1 OFFSET $2
      `,
      [limit, offset, userId]
    );

    const videos = result.rows.map((row) => {
      const enriched = withFallbackEnrichment(row);
      return {
        ...enriched,
        search_tags: safeTextArray(enriched.search_tags),
        liked_by_me: Boolean(enriched.liked_by_me),
        can_delete: Boolean(userId && (enriched.owner_id === userId || isAdmin)),
        stream_url: streamUrl(enriched.id),
        thumbnail_url: thumbnailUrl(enriched.id),
      };
    });

    res.json({ items: videos, limit, offset });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/videos/history/watch", requireUser, async (req, res) => {
  const limit = clamp(Number(req.query.limit || 25), 1, 100);
  try {
    const result = await query(
      `
        WITH latest_per_video AS (
          SELECT DISTINCT ON (s.video_id)
            s.video_id,
            s.last_event_at,
            s.last_watch_seconds,
            s.max_watch_seconds,
            s.completion_rate_max
          FROM video_watch_sessions s
          JOIN videos v ON v.id = s.video_id
          WHERE s.user_id = $1
            AND v.status = 'READY'
            AND s.max_watch_seconds > 0
          ORDER BY s.video_id, s.last_event_at DESC
        )
        SELECT
          lpv.video_id::text AS video_id,
          v.title,
          v.description,
          v.created_at AS video_created_at,
          lpv.last_event_at,
          lpv.last_watch_seconds,
          lpv.max_watch_seconds,
          lpv.completion_rate_max,
          COALESCE(v.duration_seconds, 0) AS duration_seconds,
          COALESCE(a.view_count, 0) AS view_count,
          COALESCE(a.like_count, 0) AS like_count,
          COALESCE(a.comment_count, 0) AS comment_count
        FROM latest_per_video lpv
        JOIN videos v ON v.id = lpv.video_id
        LEFT JOIN video_aggregates a ON a.video_id = lpv.video_id
        ORDER BY lpv.last_event_at DESC
        LIMIT $2
      `,
      [req.user.id, limit]
    );

    const items = result.rows.map((row) => ({
      video_id: row.video_id,
      title: row.title,
      description: row.description,
      duration_seconds: Number(row.duration_seconds || 0),
      last_watch_seconds: Number(row.last_watch_seconds || 0),
      progress_percent: Math.round(Math.max(0, Math.min(1, Number(row.completion_rate_max || 0))) * 100),
      last_watched_at: row.last_event_at,
      created_at: row.video_created_at,
      view_count: Number(row.view_count || 0),
      like_count: Number(row.like_count || 0),
      comment_count: Number(row.comment_count || 0),
    }));
    return res.json({ items, limit });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/videos/history/search", requireUser, async (req, res) => {
  const limit = clamp(Number(req.query.limit || 20), 1, 100);
  try {
    const result = await query(
      `
        SELECT query_text, created_at
        FROM user_search_events
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [req.user.id, limit]
    );
    return res.json({ items: result.rows, limit });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/videos/history/search", requireUser, async (req, res) => {
  const queryText = normalizeSearchQuery(req.body.query || "");
  if (queryText.length < 2) {
    return res.status(400).json({ error: "query must be at least 2 characters" });
  }

  try {
    await query(
      `
        INSERT INTO user_search_events (user_id, query_text)
        VALUES ($1, $2)
      `,
      [req.user.id, queryText]
    );
    return res.status(201).json({ ok: true, query: queryText });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/videos/search", async (req, res) => {
  const user = resolveUserFromHeaders(req);
  const userId = user?.id || null;
  const isAdmin = isAdminUser(user);
  const q = normalizeSearchQuery(req.query.q || "");
  const limit = clamp(Number(req.query.limit || 24), 1, 50);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  if (q.length < 1) {
    return res.status(400).json({ error: "q is required" });
  }

  const qLower = q.toLowerCase();
  const qAny = `%${qLower}%`;
  const candidateLimit = clamp(Math.max(limit * 16, 160), 120, 360);

  try {
    const result = await query(
      `
        SELECT
          v.id,
          v.owner_id,
          v.title,
          v.description,
          v.status,
          v.created_at,
          v.duration_seconds,
          COALESCE(a.like_count, 0) AS like_count,
          COALESCE(a.comment_count, 0) AS comment_count,
          COALESCE(a.view_count, 0) AS view_count,
          COALESCE(a.watch_time_total, 0) AS watch_time_total,
          ARRAY[]::TEXT[] AS search_tags,
          ''::TEXT AS generated_description,
          ARRAY[]::TEXT[] AS audio_labels,
          ARRAY[]::TEXT[] AS visual_labels,
          ''::TEXT AS content_category,
          ''::TEXT AS semantic_text,
          '[]'::jsonb AS embedding_json,
          (
            CASE
              WHEN LOWER(v.title) = $1 THEN 240
              WHEN LOWER(v.title) LIKE $2 THEN 180
              WHEN LOWER(v.title) LIKE $3 THEN 135
              WHEN LOWER(v.description) LIKE $3 THEN 100
              ELSE 0
            END
            + (
              155 * ts_rank_cd(
                setweight(to_tsvector('simple', COALESCE(v.title, '')), 'A')
                || setweight(to_tsvector('simple', COALESCE(v.description, '')), 'B'),
                plainto_tsquery('simple', $1)
              )
            )
          ) AS search_rank,
          CASE
            WHEN $4::uuid IS NULL THEN FALSE
            ELSE l.user_id IS NOT NULL
          END AS liked_by_me
        FROM videos v
        LEFT JOIN video_aggregates a ON a.video_id = v.id
        LEFT JOIN video_likes l ON l.video_id = v.id AND l.user_id = $4::uuid
        WHERE v.status = 'READY'
        ORDER BY search_rank DESC, COALESCE(a.view_count, 0) DESC, v.created_at DESC
        LIMIT $5
      `,
      [qLower, `${qLower}%`, qAny, userId, candidateLimit]
    );

    const scoredAll = result.rows
      .map((row) => {
        const lexicalScore = Number(row.search_rank || 0);
        const engagementBoost =
          Math.log10(1 + Number(row.view_count || 0)) * 2 +
          Math.log10(1 + Number(row.like_count || 0)) * 1.5;
        const baseText = `${row.title || ""} ${row.description || ""}`.toLowerCase();
        const compactBaseText = baseText.replace(/[^a-z0-9]/g, "");
        const compactQuery = qLower.replace(/[^a-z0-9]/g, "");
        const lexicalHit =
          baseText.includes(qLower) ||
          (compactQuery.length >= 4 && compactBaseText.includes(compactQuery)) ||
          lexicalScore > 1.8;

        return {
          ...row,
          lexical_hit: lexicalHit,
          final_rank: lexicalScore + engagementBoost,
        };
      })
      .filter((row) => Number.isFinite(row.final_rank));

    const lexicalMatches = scoredAll.filter((row) => row.lexical_hit);
    const scored = lexicalMatches
      .sort((a, b) => b.final_rank - a.final_rank || new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const page = scored.slice(offset, offset + limit);
    const items = page.map((row) => ({
      id: row.id,
      owner_id: row.owner_id,
      title: row.title,
      description: row.description,
      status: row.status,
      created_at: row.created_at,
      duration_seconds: row.duration_seconds,
      like_count: Number(row.like_count || 0),
      comment_count: Number(row.comment_count || 0),
      view_count: Number(row.view_count || 0),
      watch_time_total: Number(row.watch_time_total || 0),
      generated_description: "",
      search_tags: [],
      content_category: "",
      semantic_score: 0,
      semantic_method: "disabled",
      liked_by_me: Boolean(row.liked_by_me),
      can_delete: Boolean(userId && (row.owner_id === userId || isAdmin)),
      stream_url: streamUrl(row.id),
      thumbnail_url: thumbnailUrl(row.id),
    }));
    return res.json({ q, items, limit, offset });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/videos/:id", async (req, res) => {
  const { id } = req.params;
  const user = resolveUserFromHeaders(req);
  const userId = user?.id || null;
  const isAdmin = isAdminUser(user);
  try {
    const result = await query(
      `
        SELECT
          v.id,
          v.owner_id,
          v.title,
          v.description,
          v.raw_object_key,
          v.processed_prefix,
          v.duration_seconds,
          v.status,
          v.created_at,
          v.updated_at,
          COALESCE(a.like_count, 0) AS like_count,
          COALESCE(a.comment_count, 0) AS comment_count,
          COALESCE(a.view_count, 0) AS view_count,
          COALESCE(a.watch_time_total, 0) AS watch_time_total,
          ''::TEXT AS generated_title,
          ''::TEXT AS generated_description,
          ARRAY[]::TEXT[] AS search_tags,
          ARRAY[]::TEXT[] AS audio_labels,
          ARRAY[]::TEXT[] AS visual_labels,
          ''::TEXT AS content_category,
          'manual'::TEXT AS enrichment_model_version,
          CASE
            WHEN $2::uuid IS NULL THEN FALSE
            ELSE l.user_id IS NOT NULL
          END AS liked_by_me
        FROM videos v
        LEFT JOIN video_aggregates a ON a.video_id = v.id
        LEFT JOIN video_likes l ON l.video_id = v.id AND l.user_id = $2::uuid
        WHERE v.id = $1
      `,
      [id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "video not found" });
    }

    const video = withFallbackEnrichment(result.rows[0]);
    return res.json({
      ...video,
      search_tags: safeTextArray(video.search_tags),
      audio_labels: safeTextArray(video.audio_labels),
      visual_labels: safeTextArray(video.visual_labels),
      liked_by_me: Boolean(video.liked_by_me),
      can_delete: Boolean(userId && (video.owner_id === userId || isAdmin)),
      stream_url: video.status === "READY" ? streamUrl(video.id) : null,
      thumbnail_url: video.status === "READY" ? thumbnailUrl(video.id) : null,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/videos/:id/status", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await query(
      `
        SELECT
          v.id,
          v.status,
          v.updated_at,
          v.created_at,
          t.attempts,
          t.last_error,
          CASE
            WHEN v.status IN ('UPLOADED', 'PROCESSING')
            THEN (
              SELECT COUNT(*)
              FROM videos q
              WHERE q.status IN ('UPLOADED', 'PROCESSING')
                AND q.created_at < v.created_at
            )
            ELSE 0
          END AS queue_ahead,
          CASE
            WHEN v.status IN ('UPLOADED', 'PROCESSING')
            THEN (
              SELECT COUNT(*)
              FROM videos q
              WHERE q.status IN ('UPLOADED', 'PROCESSING')
            )
            ELSE 0
          END AS queue_total,
          (
            SELECT q.id
            FROM videos q
            WHERE q.status = 'PROCESSING'
            ORDER BY q.updated_at DESC, q.created_at ASC
            LIMIT 1
          ) AS processing_video_id
        FROM videos v
        LEFT JOIN transcode_jobs t ON t.video_id = v.id
        WHERE v.id = $1
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "video not found" });
    }
    const row = result.rows[0];
    const queueAhead = Number(row.queue_ahead || 0);
    const queueTotal = Number(row.queue_total || 0);
    const queuePosition =
      String(row.status || "").toUpperCase() === "UPLOADED" || String(row.status || "").toUpperCase() === "PROCESSING"
        ? queueAhead + 1
        : 0;
    return res.json({
      id: row.id,
      status: row.status,
      updated_at: row.updated_at,
      created_at: row.created_at,
      attempts: Number(row.attempts || 0),
      last_error: row.last_error || "",
      queue_ahead: queueAhead,
      queue_total: queueTotal,
      queue_position: queuePosition,
      processing_video_id: row.processing_video_id || null,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/videos/:id/stats", async (req, res) => {
  try {
    const stats = await readStats(req.params.id);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/videos/:id/enrichment", async (req, res) => {
  return res.json({
    video_id: req.params.id,
    enabled: false,
    note: "Auto enrichment is disabled. Use user-provided title and description.",
    tags: [],
    audio_labels: [],
    visual_labels: [],
    content_category: "",
    model_version: "manual",
  });
});

app.get("/videos/:id/comments", async (req, res) => {
  const limit = clamp(Number(req.query.limit || 20), 1, 100);
  try {
    const result = await query(
      `
        SELECT c.id, c.video_id, c.user_id, u.email AS user_email, c.comment_text, c.created_at
        FROM video_comments c
        LEFT JOIN users u ON u.id = c.user_id
        WHERE c.video_id = $1
        ORDER BY c.created_at DESC
        LIMIT $2
      `,
      [req.params.id, limit]
    );
    res.json({ items: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/videos/upload", requireUser, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "file is required (multipart field name: file)" });
  }
  if (req.file.size <= 0) {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: "uploaded file is empty" });
  }
  if (!String(req.file.mimetype || "").startsWith("video/")) {
    await fs.unlink(req.file.path).catch(() => {});
    return res
      .status(400)
      .json({ error: `unsupported file type: ${req.file.mimetype || "unknown"}. Please upload a video.` });
  }

  const likelyVideo = await isLikelyVideoUpload(req.file.path).catch(() => false);
  if (!likelyVideo) {
    await fs.unlink(req.file.path).catch(() => {});
    return res
      .status(400)
      .json({ error: "uploaded content is not a valid video file. Please choose a real video file." });
  }

  const videoId = crypto.randomUUID();
  const filename = path.basename(req.file.originalname).replace(/[^\w.\-]/g, "_");
  const objectKey = `videos/${videoId}/raw/${Date.now()}-${filename}`;
  const title = String(req.body.title || req.file.originalname || "Untitled Video").trim();
  const description = String(req.body.description || "").trim();

  try {
    await uploadFile(config.minioRawBucket, objectKey, req.file.path, req.file.mimetype);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO videos (
            id, owner_id, title, description, raw_object_key, status
          )
          VALUES ($1, $2, $3, $4, $5, 'UPLOADED')
        `,
        [videoId, req.user.id, title, description, objectKey]
      );

      await client.query(
        `
          INSERT INTO transcode_jobs (video_id, attempts, last_error, last_attempt_at)
          VALUES ($1, 0, NULL, NULL)
          ON CONFLICT (video_id) DO NOTHING
        `,
        [videoId]
      );

      await client.query(
        `
          INSERT INTO video_aggregates (video_id)
          VALUES ($1)
          ON CONFLICT (video_id) DO NOTHING
        `,
        [videoId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await publishEvent("video_uploaded", {
      video_id: videoId,
      raw_object_key: objectKey,
      retry_count: 0,
      owner_id: req.user.id,
    });

    return res.status(201).json({
      id: videoId,
      title,
      description,
      status: "UPLOADED",
      message: "Upload accepted and queued for transcoding",
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
});

app.post("/videos/:id/finalize", requireUser, async (req, res) => {
  const { id } = req.params;
  const force = String(req.body?.force || req.query.force || "")
    .toLowerCase()
    .trim() === "true";
  try {
    const result = await query(
      `SELECT id, owner_id, status, raw_object_key FROM videos WHERE id = $1`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "video not found" });
    }

    const video = result.rows[0];
    if (video.owner_id !== req.user.id && !isAdminUser(req.user)) {
      return res.status(403).json({ error: "forbidden" });
    }

    if (video.status !== "READY" || force) {
      await query(`UPDATE videos SET status = 'UPLOADED' WHERE id = $1`, [id]);
      await publishEvent("video_uploaded", {
        video_id: id,
        raw_object_key: video.raw_object_key,
        retry_count: 0,
        owner_id: req.user.id,
        force_reprocess: force,
      });
    }

    return res.json({
      id,
      status: "UPLOADED",
      force,
      message: force ? "Re-analysis and transcode re-queued" : "Transcode job finalized/re-queued",
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.delete("/videos/:id", requireUser, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Get video details and verify ownership
    const videoResult = await client.query(
      `SELECT id, owner_id, raw_object_key, processed_prefix FROM videos WHERE id = $1`,
      [id]
    );

    if (videoResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "video not found" });
    }

    const video = videoResult.rows[0];
    if (video.owner_id !== req.user.id && !isAdminUser(req.user)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "forbidden: only the video owner or admin can delete this video" });
    }

    // Delete video record (cascading deletes: comments, likes, watch_sessions)
    await client.query(`DELETE FROM videos WHERE id = $1`, [id]);

    // Delete from transcode jobs
    await client.query(`DELETE FROM transcode_jobs WHERE video_id = $1`, [id]);

    // Delete from video_aggregates
    await client.query(`DELETE FROM video_aggregates WHERE video_id = $1`, [id]);

    // Clear cache
    await redis.del(`video:${id}:counts`);

    await client.query("COMMIT");

    // Delete files from MinIO (after transaction commits)
    try {
      // Delete raw video file
      if (video.raw_object_key) {
        await deleteFile(config.minioRawBucket, video.raw_object_key).catch((err) => {
          console.warn(`Failed to delete raw file ${video.raw_object_key}: ${err.message}`);
        });
      }

      // Delete all processed files (HLS, thumbnail, etc.)
      if (video.processed_prefix) {
        await deleteObjectsWithPrefix(config.minioProcessedBucket, video.processed_prefix).catch((err) => {
          console.warn(`Failed to delete processed files with prefix ${video.processed_prefix}: ${err.message}`);
        });
      }
    } catch (storageError) {
      console.warn(`Storage cleanup error for video ${id}: ${storageError.message}`);
      // Don't fail the request if storage cleanup fails - database cleanup still succeeded
    }

    return res.json({ id, message: "Video deleted successfully" });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post("/videos/:id/like", requireUser, async (req, res) => {
  const { id: videoId } = req.params;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `
        INSERT INTO video_likes (user_id, video_id)
        VALUES ($1, $2)
        ON CONFLICT (user_id, video_id) DO NOTHING
        RETURNING user_id
      `,
      [req.user.id, videoId]
    );

    const liked = inserted.rowCount > 0;
    if (liked) {
      await updateAggregate(client, videoId, { likes: 1 });
    }
    await client.query("COMMIT");

    if (liked) {
      await incrementCache(videoId, { likes: 1 });
      await publishEvent("user_interaction_logged", {
        action: "like",
        user_id: req.user.id,
        video_id: videoId,
      });
    }

    return res.json({ liked, video_id: videoId });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.delete("/videos/:id/like", requireUser, async (req, res) => {
  const { id: videoId } = req.params;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const deleted = await client.query(
      `
        DELETE FROM video_likes
        WHERE user_id = $1 AND video_id = $2
        RETURNING user_id
      `,
      [req.user.id, videoId]
    );

    const unliked = deleted.rowCount > 0;
    if (unliked) {
      await updateAggregate(client, videoId, { likes: -1 });
    }
    await client.query("COMMIT");

    if (unliked) {
      await incrementCache(videoId, { likes: -1 });
      await publishEvent("user_interaction_logged", {
        action: "unlike",
        user_id: req.user.id,
        video_id: videoId,
      });
    }

    return res.json({ unliked, video_id: videoId });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post("/videos/:id/comment", requireUser, async (req, res) => {
  const { id: videoId } = req.params;
  const rawComment = String(req.body.comment || "");
  const comment = sanitizeComment(rawComment);
  if (rawComment.trim().length > config.maxCommentLength) {
    return res
      .status(400)
      .json({ error: `comment is too long (max ${config.maxCommentLength} characters)` });
  }
  if (!comment) {
    return res.status(400).json({ error: "comment is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `
        INSERT INTO video_comments (user_id, video_id, comment_text)
        VALUES ($1, $2, $3)
        RETURNING id, user_id, video_id, comment_text, created_at
      `,
      [req.user.id, videoId, comment]
    );
    await updateAggregate(client, videoId, { comments: 1 });
    await client.query("COMMIT");

    await incrementCache(videoId, { comments: 1 });
    await publishEvent("user_interaction_logged", {
      action: "comment",
      user_id: req.user.id,
      video_id: videoId,
    });

    return res.status(201).json(inserted.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post("/videos/:id/view", async (req, res) => {
  const { id: videoId } = req.params;
  const user = resolveUserFromHeaders(req);
  const userId = user?.id || null;
  const hasClientSessionId = Boolean(String(req.body.sessionId || "").trim());
  const sessionId = ensureSessionId(req.body.sessionId, userId, videoId, req);

  const watchTimeSeconds = clamp(toFloat(req.body.watchTimeSeconds, 0), 0, 10 * 60 * 60);
  const completionRate = clamp(toFloat(req.body.completionRate, 0), 0, 1);
  const durationSeconds = clamp(toFloat(req.body.durationSeconds, 0), 0, 10 * 60 * 60);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const videoResult = await client.query(
      `
        SELECT COALESCE(duration_seconds, 0) AS duration_seconds
        FROM videos
        WHERE id = $1
      `,
      [videoId]
    );
    if (videoResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "video not found" });
    }

    const dbDuration = Number(videoResult.rows[0].duration_seconds || 0);
    const durationHint = Math.max(dbDuration, durationSeconds, watchTimeSeconds);
    const sessionResult = await client.query(
      `
        SELECT
          user_id,
          last_watch_seconds,
          max_watch_seconds,
          completion_rate_max,
          counted_view
        FROM video_watch_sessions
        WHERE video_id = $1 AND session_id = $2
        FOR UPDATE
      `,
      [videoId, sessionId]
    );

    const sessionRow = sessionResult.rows[0] || null;
    const previousLastWatch = Number(sessionRow?.last_watch_seconds || 0);
    const previousMaxWatch = Number(sessionRow?.max_watch_seconds || 0);
    const previousCompletion = Number(sessionRow?.completion_rate_max || 0);
    const wasCountedView = Boolean(sessionRow?.counted_view);
    const effectiveWatchTime = Math.max(0, watchTimeSeconds);
    const watchDeltaSeconds = Math.max(0, effectiveWatchTime - previousLastWatch);
    const maxWatchSeconds = Math.max(previousMaxWatch, effectiveWatchTime);
    const inferredCompletionRate =
      durationHint > 0 ? clamp(maxWatchSeconds / durationHint, 0, 1) : completionRate;
    const completionRateMax = Math.max(previousCompletion, completionRate, inferredCompletionRate);
    const qualifiedViewThreshold = Math.max(
      config.minQualifiedViewSeconds,
      durationHint * config.minQualifiedViewCompletionRate
    );
    const qualifiesView =
      !wasCountedView &&
      (maxWatchSeconds >= qualifiedViewThreshold ||
        completionRateMax >= config.minQualifiedViewCompletionRate);

    if (sessionRow) {
      await client.query(
        `
          UPDATE video_watch_sessions
          SET
            user_id = COALESCE(video_watch_sessions.user_id, $3::uuid),
            last_event_at = NOW(),
            last_watch_seconds = $4,
            max_watch_seconds = $5,
            completion_rate_max = $6,
            duration_seconds_hint = GREATEST(duration_seconds_hint, $7),
            counted_view = counted_view OR $8
          WHERE video_id = $1 AND session_id = $2
        `,
        [
          videoId,
          sessionId,
          userId,
          effectiveWatchTime,
          maxWatchSeconds,
          completionRateMax,
          durationHint,
          qualifiesView,
        ]
      );
    } else {
      await client.query(
        `
          INSERT INTO video_watch_sessions (
            session_id,
            user_id,
            video_id,
            started_at,
            last_event_at,
            last_watch_seconds,
            max_watch_seconds,
            completion_rate_max,
            duration_seconds_hint,
            counted_view
          )
          VALUES ($1, $2, $3, NOW(), NOW(), $4, $5, $6, $7, $8)
        `,
        [sessionId, userId, videoId, effectiveWatchTime, maxWatchSeconds, completionRateMax, durationHint, qualifiesView]
      );
    }

    const inserted = await client.query(
      `
        INSERT INTO video_views (
          user_id, video_id, session_id, watch_time_seconds, watch_delta_seconds, completion_rate
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING
          id,
          user_id,
          video_id,
          session_id,
          watch_time_seconds,
          watch_delta_seconds,
          completion_rate,
          created_at
      `,
      [userId, videoId, sessionId, effectiveWatchTime, watchDeltaSeconds, completionRate]
    );
    await updateAggregate(client, videoId, {
      views: qualifiesView ? 1 : 0,
      watchTime: watchDeltaSeconds,
    });
    await client.query("COMMIT");

    await incrementCache(videoId, {
      views: qualifiesView ? 1 : 0,
      watchTime: watchDeltaSeconds,
    });
    await publishEvent("user_interaction_logged", {
      action: "view",
      user_id: userId || "anonymous",
      video_id: videoId,
      session_id: sessionId,
      watch_time_seconds: effectiveWatchTime,
      watch_delta_seconds: watchDeltaSeconds,
      completion_rate: completionRate,
      qualified_view: qualifiesView,
    });

    if (!userId) {
      incrementAuditCounter("view_missing_user_id").catch(() => {});
    }
    if (!hasClientSessionId) {
      incrementAuditCounter("view_missing_client_session_id").catch(() => {});
    }

    return res.status(201).json({
      ...inserted.rows[0],
      qualified_view: qualifiesView,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  return res.status(500).json({ error: err.message || "internal server error" });
});

async function runMigrations() {
  await query(
    `
      ALTER TABLE video_views
      ADD COLUMN IF NOT EXISTS session_id TEXT
    `
  );
  await query(
    `
      ALTER TABLE video_views
      ADD COLUMN IF NOT EXISTS watch_delta_seconds REAL NOT NULL DEFAULT 0
    `
  );
  await query(
    `
      CREATE INDEX IF NOT EXISTS idx_video_views_session
      ON video_views(video_id, session_id)
    `
  );
  await query(
    `
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
      )
    `
  );
  await query(
    `
      CREATE INDEX IF NOT EXISTS idx_watch_sessions_video
      ON video_watch_sessions(video_id, last_event_at DESC)
    `
  );
  await query(
    `
      CREATE INDEX IF NOT EXISTS idx_watch_sessions_user
      ON video_watch_sessions(user_id, last_event_at DESC)
    `
  );
  await query(
    `
      CREATE TABLE IF NOT EXISTS user_search_events (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        query_text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );
  await query(
    `
      CREATE INDEX IF NOT EXISTS idx_user_search_events_user_created_at
      ON user_search_events(user_id, created_at DESC)
    `
  );
}

async function bootstrap() {
  await fs.mkdir(uploadTmpDir, { recursive: true });
  await runMigrations();
  await connectRedis();

  app.listen(config.port, () => {
    console.log(`Video service listening on port ${config.port}`);
  });
}

bootstrap().catch((error) => {
  console.error("Video service startup failed", error);
  process.exit(1);
});

async function shutdown() {
  await redis.quit().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
