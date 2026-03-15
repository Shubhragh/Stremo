import hashlib
import json
import math
import re
import threading
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import psycopg2
from psycopg2.extras import RealDictCursor

TOKEN_PATTERN = re.compile(r"[a-z0-9]{2,}")
CHAR_PATTERN = re.compile(r"[a-z0-9]{3,}")

SEMANTIC_SYNONYMS = {
    "music": ["song", "audio", "melody", "beats", "lyrics"],
    "song": ["music", "track", "audio"],
    "gaming": ["gameplay", "esports", "fps", "stream"],
    "game": ["gaming", "gameplay"],
    "study": ["lecture", "tutorial", "education", "learning"],
    "tutorial": ["study", "guide", "howto"],
    "sports": ["match", "highlights", "team", "tournament"],
    "movie": ["film", "cinema", "trailer"],
    "film": ["movie", "cinema"],
    "car": ["automotive", "racing", "vehicle"],
    "automotive": ["car", "vehicle"],
    "entertainment": ["fun", "show", "comedy"],
    "comedy": ["entertainment", "funny"],
    "action": ["fight", "stunt", "battle"],
}


def _sigmoid(x: float) -> float:
    if x >= 0:
        z = math.exp(-x)
        return 1 / (1 + z)
    z = math.exp(x)
    return z / (1 + z)


def _normalize(arr: np.ndarray) -> np.ndarray:
    if arr.size == 0:
        return arr
    minimum = float(arr.min())
    maximum = float(arr.max())
    if maximum - minimum < 1e-9:
        return np.zeros_like(arr)
    return (arr - minimum) / (maximum - minimum)


def _normalize_vector(arr: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(arr))
    if norm < 1e-12:
        return arr
    return arr / norm


def _normalize_rows(matrix: np.ndarray) -> np.ndarray:
    if matrix.size == 0:
        return matrix
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms < 1e-12] = 1.0
    return matrix / norms


def _safe_float(value, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    if math.isnan(result) or math.isinf(result):
        return fallback
    return result


def _to_iso(ts) -> Optional[str]:
    if ts is None:
        return None
    return ts.isoformat()


def _tokenize(text: str) -> List[str]:
    return TOKEN_PATTERN.findall((text or "").lower())


def _token_index(token: str, dim: int) -> int:
    digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).hexdigest()
    return int(digest, 16) % dim


def _vectorize_text(text: str, dim: int) -> np.ndarray:
    vec = np.zeros((dim,), dtype=np.float32)
    source = (text or "").lower()
    tokens = _tokenize(source)
    if not tokens:
        return vec

    tf = Counter(tokens)
    for token, count in tf.items():
        base_weight = 1.0 + math.log1p(float(count))
        vec[_token_index(token, dim)] += base_weight

        for related in SEMANTIC_SYNONYMS.get(token, [])[:3]:
            vec[_token_index(related, dim)] += 0.32 * base_weight

    for idx in range(len(tokens) - 1):
        bigram = f"{tokens[idx]}_{tokens[idx + 1]}"
        vec[_token_index(bigram, dim)] += 0.48

    compact = "".join(ch for ch in source if ch.isalnum() or ch.isspace())
    for token in CHAR_PATTERN.findall(compact):
        limit = min(len(token) - 2, 8)
        for start in range(max(0, limit)):
            trigram = token[start : start + 3]
            if len(trigram) == 3:
                vec[_token_index(f"cg:{trigram}", dim)] += 0.06

    return _normalize_vector(vec)


class CompactSemanticEncoder:
    def __init__(self, fallback_dim: int = 384) -> None:
        self.model_name = "builtin-hash-ngram"
        self.fallback_dim = int(max(64, fallback_dim))
        self.method = "hash+ngram-v2"

    def embed(self, texts: List[str]) -> np.ndarray:
        clean = [str(text or "").strip()[:4000] for text in texts]
        if not clean:
            return np.zeros((0, self.fallback_dim), dtype=np.float32)

        fallback = np.vstack([_vectorize_text(text, self.fallback_dim) for text in clean]).astype(np.float32)
        return _normalize_rows(fallback)


@dataclass
class RecommenderModel:
    trained_at: float
    user_to_index: Dict[str, int]
    video_to_index: Dict[str, int]
    index_to_video: List[str]
    user_factors: np.ndarray
    item_factors: np.ndarray
    popularity: np.ndarray
    recency: np.ndarray
    item_content_vectors: np.ndarray
    user_content_vectors: np.ndarray
    global_user_vector: np.ndarray
    global_content_vector: np.ndarray
    blend_weights: np.ndarray
    user_positives: Dict[int, set]
    fallback_videos: List[str]
    training_summary: Dict[str, float]


class RecommenderEngine:
    def __init__(
        self,
        db_url: str,
        model_dir: str,
        latent_dim: int = 32,
        epochs: int = 25,
        learning_rate: float = 0.035,
        regularization: float = 0.0025,
        train_samples_per_user: int = 25,
        recency_half_life_days: float = 10.0,
        search_half_life_days: float = 21.0,
        content_vector_dim: int = 256,
        semantic_fallback_dim: int = 384,
    ) -> None:
        self.db_url = db_url
        self.model_dir = Path(model_dir)
        self.model_dir.mkdir(parents=True, exist_ok=True)
        self.latent_dim = latent_dim
        self.epochs = epochs
        self.learning_rate = learning_rate
        self.regularization = regularization
        self.train_samples_per_user = train_samples_per_user
        self.recency_half_life_days = recency_half_life_days
        self.search_half_life_days = search_half_life_days
        self.content_vector_dim = content_vector_dim
        self.semantic_encoder = CompactSemanticEncoder(fallback_dim=semantic_fallback_dim)

        self._lock = threading.Lock()
        self._model: Optional[RecommenderModel] = None
        self._load_model_if_present()

    @staticmethod
    def _default_blend_weights() -> np.ndarray:
        # [collab, content, live_content, popularity, recency]
        return np.array([0.34, 0.25, 0.23, 0.12, 0.06], dtype=np.float32)

    def _coerce_blend_weights(self, weights: np.ndarray) -> np.ndarray:
        arr = np.asarray(weights, dtype=np.float32).reshape(-1)
        if arr.size != 5 or not np.isfinite(arr).all():
            return self._default_blend_weights()
        arr = np.clip(arr, 0.0, None)
        total = float(arr.sum())
        if total < 1e-8:
            return self._default_blend_weights()
        return (arr / total).astype(np.float32)

    def _connect(self):
        return psycopg2.connect(self.db_url)

    def _load_model_if_present(self) -> None:
        arrays_path = self.model_dir / "model.npz"
        meta_path = self.model_dir / "meta.json"
        if not arrays_path.exists() or not meta_path.exists():
            return

        try:
            data = np.load(arrays_path, allow_pickle=True)
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            user_to_index = {k: int(v) for k, v in meta.get("user_to_index", {}).items()}
            video_to_index = {k: int(v) for k, v in meta.get("video_to_index", {}).items()}
            index_to_video = meta.get("index_to_video", [])
            user_positives = {
                int(k): set(int(i) for i in v) for k, v in meta.get("user_positives", {}).items()
            }
            item_count = len(index_to_video)
            user_count = len(user_to_index)
            content_dim = int(meta.get("content_vector_dim", self.content_vector_dim))

            def read_array(name: str, fallback_shape: Tuple[int, ...]):
                if name in data:
                    return data[name]
                return np.zeros(fallback_shape, dtype=np.float32)

            blend_weights = (
                data["blend_weights"].astype(np.float32)
                if "blend_weights" in data
                else np.array(meta.get("blend_weights", self._default_blend_weights().tolist()), dtype=np.float32)
            )

            self._model = RecommenderModel(
                trained_at=float(meta.get("trained_at", time.time())),
                user_to_index=user_to_index,
                video_to_index=video_to_index,
                index_to_video=index_to_video,
                user_factors=read_array("user_factors", (user_count, self.latent_dim)).astype(np.float32),
                item_factors=read_array("item_factors", (item_count, self.latent_dim)).astype(np.float32),
                popularity=read_array("popularity", (item_count,)).astype(np.float32),
                recency=read_array("recency", (item_count,)).astype(np.float32),
                item_content_vectors=read_array("item_content_vectors", (item_count, content_dim)).astype(np.float32),
                user_content_vectors=read_array("user_content_vectors", (user_count, content_dim)).astype(np.float32),
                global_user_vector=read_array("global_user_vector", (self.latent_dim,)).astype(np.float32),
                global_content_vector=read_array("global_content_vector", (content_dim,)).astype(np.float32),
                blend_weights=self._coerce_blend_weights(blend_weights),
                user_positives=user_positives,
                fallback_videos=meta.get("fallback_videos", []),
                training_summary=meta.get("training_summary", {}),
            )
        except Exception:
            self._model = None

    def _persist_model(self, model: RecommenderModel) -> None:
        arrays_path = self.model_dir / "model.npz"
        meta_path = self.model_dir / "meta.json"
        np.savez_compressed(
            arrays_path,
            user_factors=model.user_factors,
            item_factors=model.item_factors,
            popularity=model.popularity,
            recency=model.recency,
            item_content_vectors=model.item_content_vectors,
            user_content_vectors=model.user_content_vectors,
            global_user_vector=model.global_user_vector,
            global_content_vector=model.global_content_vector,
            blend_weights=model.blend_weights,
        )
        meta_path.write_text(
            json.dumps(
                {
                    "trained_at": model.trained_at,
                    "user_to_index": model.user_to_index,
                    "video_to_index": model.video_to_index,
                    "index_to_video": model.index_to_video,
                    "user_positives": {str(k): sorted(v) for k, v in model.user_positives.items()},
                    "fallback_videos": model.fallback_videos,
                    "training_summary": model.training_summary,
                    "content_vector_dim": int(model.item_content_vectors.shape[1])
                    if model.item_content_vectors.ndim == 2
                    else self.content_vector_dim,
                    "blend_weights": [float(v) for v in model.blend_weights.tolist()],
                }
            ),
            encoding="utf-8",
        )

    def _train_blend_weights(
        self,
        user_factors: np.ndarray,
        item_factors: np.ndarray,
        user_content: np.ndarray,
        item_content: np.ndarray,
        popularity: np.ndarray,
        recency: np.ndarray,
        user_positives: Dict[int, set],
    ) -> Tuple[np.ndarray, Dict[str, float]]:
        default_weights = self._default_blend_weights()
        if item_factors.size == 0 or user_factors.size == 0:
            return default_weights, {"blend_samples": 0, "blend_logloss": None, "blend_auc": None}

        rng = np.random.default_rng(seed=1337)
        all_items = np.arange(item_factors.shape[0], dtype=np.int32)
        rows = []
        labels = []
        active_users = [u_idx for u_idx, positives in user_positives.items() if positives]
        if not active_users:
            return default_weights, {"blend_samples": 0, "blend_logloss": None, "blend_auc": None}

        for u_idx in active_users:
            positives = list(user_positives.get(u_idx, set()))
            if not positives:
                continue

            collab_scores = np.dot(item_factors, user_factors[u_idx]) if item_factors.size else np.zeros_like(popularity)
            content_scores = (
                np.dot(item_content, user_content[u_idx])
                if item_content.size and user_content.size and u_idx < user_content.shape[0]
                else np.zeros_like(popularity)
            )
            collab_norm = _normalize(collab_scores) if collab_scores.size else np.zeros_like(popularity)
            content_norm = _normalize(content_scores) if content_scores.size else np.zeros_like(popularity)
            live_norm = content_norm

            pos_count = min(max(4, len(positives)), 14)
            replace = len(positives) < pos_count
            sampled_pos = rng.choice(np.array(positives, dtype=np.int32), size=pos_count, replace=replace)
            for i_idx in np.atleast_1d(sampled_pos):
                i_idx = int(i_idx)
                rows.append(
                    [
                        float(collab_norm[i_idx]),
                        float(content_norm[i_idx]),
                        float(live_norm[i_idx]),
                        float(popularity[i_idx]),
                        float(recency[i_idx]),
                    ]
                )
                labels.append(1.0)

                j_idx = int(rng.choice(all_items))
                tries = 0
                while j_idx in user_positives[u_idx] and tries < 30:
                    j_idx = int(rng.choice(all_items))
                    tries += 1
                if j_idx in user_positives[u_idx]:
                    continue
                rows.append(
                    [
                        float(collab_norm[j_idx]),
                        float(content_norm[j_idx]),
                        float(live_norm[j_idx]),
                        float(popularity[j_idx]),
                        float(recency[j_idx]),
                    ]
                )
                labels.append(0.0)

        if len(rows) < 40:
            return default_weights, {"blend_samples": int(len(rows)), "blend_logloss": None, "blend_auc": None}

        x = np.array(rows, dtype=np.float64)
        y = np.array(labels, dtype=np.float64)
        x_mean = x.mean(axis=0)
        x_std = x.std(axis=0)
        x_std[x_std < 1e-6] = 1.0
        x_norm = (x - x_mean) / x_std

        w = np.zeros((x_norm.shape[1],), dtype=np.float64)
        bias = 0.0
        lr = 0.08
        reg = 0.0025
        batch_size = min(256, max(32, len(y) // 12))

        for _ in range(120):
            order = rng.permutation(len(y))
            for start in range(0, len(order), batch_size):
                idx = order[start : start + batch_size]
                xb = x_norm[idx]
                yb = y[idx]
                logits = np.clip(xb @ w + bias, -20.0, 20.0)
                preds = 1.0 / (1.0 + np.exp(-logits))
                err = preds - yb
                grad_w = (xb.T @ err) / max(1, len(idx)) + reg * w
                grad_b = float(err.mean())
                w -= lr * grad_w
                bias -= lr * grad_b

        logits = np.clip(x_norm @ w + bias, -20.0, 20.0)
        probs = 1.0 / (1.0 + np.exp(-logits))
        eps = 1e-8
        logloss = float(-(y * np.log(probs + eps) + (1 - y) * np.log(1 - probs + eps)).mean())

        pos_scores = probs[y > 0.5]
        neg_scores = probs[y < 0.5]
        auc = 0.5
        if pos_scores.size > 0 and neg_scores.size > 0:
            max_pairs = int(min(20000, pos_scores.size * neg_scores.size))
            if pos_scores.size * neg_scores.size <= max_pairs:
                margin = (pos_scores[:, None] - neg_scores[None, :]).reshape(-1)
            else:
                pos_idx = rng.integers(0, pos_scores.size, size=max_pairs)
                neg_idx = rng.integers(0, neg_scores.size, size=max_pairs)
                margin = pos_scores[pos_idx] - neg_scores[neg_idx]
            auc = float(np.mean((margin > 0).astype(np.float64) + 0.5 * (margin == 0).astype(np.float64)))

        # Convert learned linear coefficients into stable non-negative blend weights.
        learned_signal = np.abs(w / x_std)
        blend_weights = self._coerce_blend_weights(learned_signal.astype(np.float32))
        metrics = {
            "blend_samples": int(len(y)),
            "blend_logloss": logloss,
            "blend_auc": auc,
        }
        return blend_weights, metrics

    def _fetch_videos(self) -> List[Dict]:
        with self._connect() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT
                        v.id::text AS video_id,
                        v.title,
                        v.description,
                        v.created_at,
                        COALESCE(v.duration_seconds, 0) AS duration_seconds,
                        COALESCE(a.like_count, 0) AS like_count,
                        COALESCE(a.comment_count, 0) AS comment_count,
                        COALESCE(a.view_count, 0) AS view_count,
                        COALESCE(a.watch_time_total, 0) AS watch_time_total
                    FROM videos v
                    LEFT JOIN video_aggregates a ON a.video_id = v.id
                    WHERE v.status = 'READY'
                    ORDER BY v.created_at DESC
                    """
                )
                return list(cur.fetchall())

    def _fetch_interactions(self) -> List[Dict]:
        with self._connect() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'video_views'
                      AND column_name = 'watch_delta_seconds'
                    LIMIT 1
                    """
                )
                watch_expr = (
                    "COALESCE(watch_delta_seconds, watch_time_seconds)"
                    if cur.fetchone()
                    else "watch_time_seconds"
                )
                cur.execute(
                    f"""
                    WITH view_features AS (
                        SELECT
                            user_id::text AS user_id,
                            video_id::text AS video_id,
                            SUM({watch_expr}) AS watch_time_seconds,
                            AVG(completion_rate) AS completion_rate
                        FROM video_views
                        WHERE user_id IS NOT NULL
                        GROUP BY user_id, video_id
                    ),
                    like_features AS (
                        SELECT user_id::text AS user_id, video_id::text AS video_id, 1 AS like_flag
                        FROM video_likes
                    ),
                    comment_features AS (
                        SELECT user_id::text AS user_id, video_id::text AS video_id, 1 AS comment_flag
                        FROM video_comments GROUP BY user_id, video_id
                    ),
                    merged AS (
                        SELECT
                            COALESCE(v.user_id, l.user_id, c.user_id) AS user_id,
                            COALESCE(v.video_id, l.video_id, c.video_id) AS video_id,
                            COALESCE(v.watch_time_seconds, 0) AS watch_time_seconds,
                            COALESCE(v.completion_rate, 0) AS completion_rate,
                            COALESCE(l.like_flag, 0) AS like_flag,
                            COALESCE(c.comment_flag, 0) AS comment_flag
                        FROM view_features v
                        FULL OUTER JOIN like_features l ON v.user_id = l.user_id AND v.video_id = l.video_id
                        FULL OUTER JOIN comment_features c
                            ON COALESCE(v.user_id, l.user_id) = c.user_id
                           AND COALESCE(v.video_id, l.video_id) = c.video_id
                    )
                    SELECT
                        m.user_id,
                        m.video_id,
                        m.watch_time_seconds,
                        m.completion_rate,
                        m.like_flag,
                        m.comment_flag,
                        COALESCE(v.duration_seconds, 0) AS duration_seconds,
                        v.created_at
                    FROM merged m
                    JOIN videos v ON v.id::text = m.video_id
                    WHERE v.status = 'READY'
                    """
                )
                return list(cur.fetchall())

    def _fetch_search_events(self) -> List[Dict]:
        with self._connect() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT user_id::text AS user_id, query_text, created_at
                    FROM user_search_events
                    ORDER BY created_at DESC
                    LIMIT 50000
                    """
                )
                return list(cur.fetchall())

    def _fetch_continue_rows(self, user_id: str, limit: int) -> List[Dict]:
        with self._connect() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    WITH latest_per_video AS (
                        SELECT DISTINCT ON (s.video_id)
                            s.video_id,
                            s.last_event_at,
                            s.max_watch_seconds,
                            s.completion_rate_max
                        FROM video_watch_sessions s
                        JOIN videos v ON v.id = s.video_id
                        WHERE s.user_id::text = %s
                          AND v.status = 'READY'
                          AND s.max_watch_seconds > 0
                          AND s.completion_rate_max < 0.97
                        ORDER BY s.video_id, s.last_event_at DESC
                    )
                    SELECT
                        v.id::text AS video_id,
                        v.title,
                        v.description,
                        v.created_at,
                        COALESCE(v.duration_seconds, 0) AS duration_seconds,
                        COALESCE(a.like_count, 0) AS like_count,
                        COALESCE(a.comment_count, 0) AS comment_count,
                        COALESCE(a.view_count, 0) AS view_count,
                        COALESCE(a.watch_time_total, 0) AS watch_time_total,
                        lpv.last_event_at AS last_watched_at,
                        lpv.max_watch_seconds AS last_watch_time_seconds,
                        lpv.completion_rate_max AS completion_rate
                    FROM latest_per_video lpv
                    JOIN videos v ON v.id = lpv.video_id
                    LEFT JOIN video_aggregates a ON a.video_id = v.id
                    ORDER BY lpv.last_event_at DESC
                    LIMIT %s
                    """,
                    [user_id, limit],
                )
                return list(cur.fetchall())

    def _catalog(self) -> Dict[str, Dict]:
        rows = self._fetch_videos()
        return {row["video_id"]: row for row in rows}

    def _item_payload(self, video: Dict, rank: int, source: str, score: Optional[float], reason: str, reason_tags: List[str], extras: Optional[Dict] = None) -> Dict:
        payload = {
            "video_id": video["video_id"],
            "id": video["video_id"],
            "title": video.get("title") or "Untitled Video",
            "description": video.get("description") or "",
            "created_at": _to_iso(video.get("created_at")),
            "duration_seconds": _safe_float(video.get("duration_seconds")),
            "like_count": int(video.get("like_count") or 0),
            "comment_count": int(video.get("comment_count") or 0),
            "view_count": int(video.get("view_count") or 0),
            "watch_time_total": _safe_float(video.get("watch_time_total")),
            "rank": rank,
            "source": source,
            "score": score,
            "reason": reason,
            "reason_tags": reason_tags,
        }
        if extras:
            payload.update(extras)
        return payload

    def _build_live_profile(self, user_id: str, model: RecommenderModel) -> Tuple[np.ndarray, bool]:
        profile = np.zeros((model.item_content_vectors.shape[1],), dtype=np.float32)
        if not user_id:
            return model.global_content_vector, False

        with self._connect() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT video_id::text AS video_id, SUM(COALESCE(watch_delta_seconds, watch_time_seconds)) AS watch_time_seconds, AVG(completion_rate) AS completion_rate
                    FROM video_views
                    WHERE user_id::text = %s
                    GROUP BY video_id
                    """,
                    [user_id],
                )
                rows = list(cur.fetchall())
                cur.execute(
                    """
                    SELECT query_text, created_at
                    FROM user_search_events
                    WHERE user_id::text = %s
                    ORDER BY created_at DESC
                    LIMIT 50
                    """,
                    [user_id],
                )
                search_rows = list(cur.fetchall())

        for row in rows:
            vid = row.get("video_id")
            if vid not in model.video_to_index:
                continue
            idx = model.video_to_index[vid]
            weight = 1.0 + min(1.0, float(row.get("completion_rate") or 0.0))
            profile += weight * model.item_content_vectors[idx]

        now = time.time()
        for row in search_rows:
            age_days = max(0.0, (now - row["created_at"].timestamp()) / 86400.0)
            weight = math.exp(-math.log(2) * age_days / self.search_half_life_days)
            profile += float(0.8 * weight) * _vectorize_text(row.get("query_text") or "", self.content_vector_dim)

        if float(np.linalg.norm(profile)) > 1e-9:
            return _normalize_vector(profile), True
        return model.global_content_vector, False

    def train(self) -> Dict:
        videos = self._fetch_videos()
        interactions = self._fetch_interactions()
        search_events = self._fetch_search_events()

        if not videos:
            summary = {"users": 0, "videos": 0, "interactions": 0, "search_events": 0, "mode": "empty"}
            model = RecommenderModel(
                trained_at=time.time(),
                user_to_index={},
                video_to_index={},
                index_to_video=[],
                user_factors=np.zeros((0, self.latent_dim), dtype=np.float32),
                item_factors=np.zeros((0, self.latent_dim), dtype=np.float32),
                popularity=np.zeros((0,), dtype=np.float32),
                recency=np.zeros((0,), dtype=np.float32),
                item_content_vectors=np.zeros((0, self.content_vector_dim), dtype=np.float32),
                user_content_vectors=np.zeros((0, self.content_vector_dim), dtype=np.float32),
                global_user_vector=np.zeros((self.latent_dim,), dtype=np.float32),
                global_content_vector=np.zeros((self.content_vector_dim,), dtype=np.float32),
                blend_weights=self._default_blend_weights(),
                user_positives={},
                fallback_videos=[],
                training_summary=summary,
            )
            with self._lock:
                self._model = model
                self._persist_model(model)
            return summary

        now = time.time()
        video_ids = [v["video_id"] for v in videos]
        video_to_index = {video_id: idx for idx, video_id in enumerate(video_ids)}
        users = sorted({r["user_id"] for r in interactions if r.get("user_id")} | {s["user_id"] for s in search_events if s.get("user_id")})
        user_to_index = {user_id: idx for idx, user_id in enumerate(users)}
        user_positives = {i: set() for i in range(len(users))}

        item_content = np.vstack([_vectorize_text(f"{v.get('title','')} {v.get('description','')}", self.content_vector_dim) for v in videos]).astype(np.float32)
        popularity = _normalize(np.array([0.60 * float(v.get("view_count", 0)) + 0.25 * float(v.get("like_count", 0)) + 0.10 * float(v.get("comment_count", 0)) + 0.05 * float(v.get("watch_time_total", 0)) for v in videos], dtype=np.float64)).astype(np.float32)
        recency = _normalize(np.array([math.exp(-math.log(2) * max(1.0, now - v["created_at"].timestamp()) / 86400.0 / self.recency_half_life_days) for v in videos], dtype=np.float64)).astype(np.float32)

        positive_pairs = []
        for row in interactions:
            uid = row.get("user_id")
            vid = row.get("video_id")
            if uid not in user_to_index or vid not in video_to_index:
                continue
            u_idx = user_to_index[uid]
            v_idx = video_to_index[vid]
            duration = max(1.0, float(row.get("duration_seconds") or 0.0))
            watch_ratio = min(1.0, float(row.get("watch_time_seconds") or 0.0) / duration)
            completion = float(row.get("completion_rate") or 0.0)
            like_flag = float(row.get("like_flag") or 0.0)
            comment_flag = float(row.get("comment_flag") or 0.0)
            score = 1.45 * watch_ratio + 1.25 * completion + 1.35 * like_flag + 1.10 * comment_flag + 0.65 * float(recency[v_idx])
            if score <= 0.05:
                continue
            user_positives[u_idx].add(v_idx)
            positive_pairs.append((u_idx, v_idx, score))

        rng = np.random.default_rng(seed=42)
        user_factors = 0.01 * rng.standard_normal((len(users), self.latent_dim)).astype(np.float32)
        item_factors = 0.01 * rng.standard_normal((len(video_ids), self.latent_dim)).astype(np.float32)
        if positive_pairs and len(users) > 0:
            all_items = np.arange(len(video_ids), dtype=np.int32)
            active_users = [u for u, pos in user_positives.items() if pos]
            for _ in range(self.epochs):
                rng.shuffle(active_users)
                for u_idx in active_users:
                    positives = list(user_positives[u_idx])
                    sample_count = max(self.train_samples_per_user, len(positives))
                    for _ in range(sample_count):
                        i_idx = int(rng.choice(positives))
                        j_idx = int(rng.choice(all_items))
                        tries = 0
                        while j_idx in user_positives[u_idx] and tries < 20:
                            j_idx = int(rng.choice(all_items))
                            tries += 1
                        if j_idx in user_positives[u_idx]:
                            continue
                        u_vec = user_factors[u_idx]
                        i_vec = item_factors[i_idx]
                        j_vec = item_factors[j_idx]
                        grad = 1.0 - _sigmoid(float(np.dot(u_vec, i_vec - j_vec)))
                        user_factors[u_idx] += self.learning_rate * (grad * (i_vec - j_vec) - self.regularization * u_vec)
                        item_factors[i_idx] += self.learning_rate * (grad * user_factors[u_idx] - self.regularization * i_vec)
                        item_factors[j_idx] += self.learning_rate * (-grad * user_factors[u_idx] - self.regularization * j_vec)

        user_content = np.zeros((len(users), self.content_vector_dim), dtype=np.float32)
        for row in search_events:
            uid = row.get("user_id")
            if uid not in user_to_index:
                continue
            age_days = max(0.0, (now - row["created_at"].timestamp()) / 86400.0)
            weight = math.exp(-math.log(2) * age_days / self.search_half_life_days)
            user_content[user_to_index[uid]] += float(weight) * _vectorize_text(row.get("query_text") or "", self.content_vector_dim)
        for u_idx, v_idx, score in positive_pairs:
            user_content[u_idx] += float(score) * item_content[v_idx]
        user_content = _normalize_rows(user_content)

        if len(users) > 0:
            weights = np.array([len(user_positives.get(i, set())) + 1 for i in range(len(users))], dtype=np.float32)
            global_user = (user_factors * weights[:, np.newaxis]).sum(axis=0) / float(weights.sum())
        else:
            global_user = np.zeros((self.latent_dim,), dtype=np.float32)
        global_user = _normalize_vector(global_user.astype(np.float32))

        non_zero_user_content = user_content[np.linalg.norm(user_content, axis=1) > 1e-9]
        if non_zero_user_content.size > 0:
            global_content = non_zero_user_content.mean(axis=0)
        else:
            global_content = item_content.mean(axis=0)
        global_content = _normalize_vector(global_content.astype(np.float32))

        prior_scores = 0.50 * _normalize(np.dot(item_factors, global_user)) + 0.35 * _normalize(np.dot(item_content, global_content)) + 0.10 * popularity + 0.05 * recency
        fallback_videos = [video_ids[int(i)] for i in np.argsort(-prior_scores)[:100]]
        blend_weights, blend_metrics = self._train_blend_weights(
            user_factors=user_factors,
            item_factors=item_factors,
            user_content=user_content,
            item_content=item_content,
            popularity=popularity,
            recency=recency,
            user_positives=user_positives,
        )
        summary = {
            "users": int(len(users)),
            "videos": int(len(video_ids)),
            "interactions": int(len(positive_pairs)),
            "search_events": int(len(search_events)),
            "mode": "hybrid_bpr_content_calibrated" if positive_pairs else "content_with_global_prior",
            "model_family": "bpr_matrix_factorization + logistic_blend_calibration",
            "blend_weights": {
                "collaborative": float(blend_weights[0]),
                "content_profile": float(blend_weights[1]),
                "live_profile": float(blend_weights[2]),
                "popularity": float(blend_weights[3]),
                "recency": float(blend_weights[4]),
            },
            **blend_metrics,
        }

        model = RecommenderModel(
            trained_at=time.time(),
            user_to_index=user_to_index,
            video_to_index=video_to_index,
            index_to_video=video_ids,
            user_factors=user_factors.astype(np.float32),
            item_factors=item_factors.astype(np.float32),
            popularity=popularity.astype(np.float32),
            recency=recency.astype(np.float32),
            item_content_vectors=item_content.astype(np.float32),
            user_content_vectors=user_content.astype(np.float32),
            global_user_vector=global_user.astype(np.float32),
            global_content_vector=global_content.astype(np.float32),
            blend_weights=blend_weights.astype(np.float32),
            user_positives=user_positives,
            fallback_videos=fallback_videos,
            training_summary=summary,
        )
        with self._lock:
            self._model = model
            self._persist_model(model)
        return summary

    def recommend(self, user_id: str, limit: int = 20) -> Dict:
        with self._lock:
            model = self._model
        if model is None or len(model.index_to_video) == 0:
            return {"source": "empty_model", "items": []}

        limit = max(1, min(limit, 100))
        catalog = self._catalog()
        if not catalog:
            return {"source": "empty_catalog", "items": []}

        known = user_id in model.user_to_index
        interacted = set()
        if known:
            u_idx = model.user_to_index[user_id]
            user_vec = model.user_factors[u_idx]
            offline_profile = model.user_content_vectors[u_idx]
            live_profile, has_live = self._build_live_profile(user_id, model)
            if float(np.linalg.norm(offline_profile)) < 1e-9:
                profile = live_profile
            elif has_live:
                profile = _normalize_vector((0.55 * offline_profile) + (0.45 * live_profile))
            else:
                profile = offline_profile
            interacted = model.user_positives.get(u_idx, set())
            source = str(model.training_summary.get("mode") or "hybrid_bpr_content_calibrated")
        else:
            user_vec = model.global_user_vector
            live_profile, live = self._build_live_profile(user_id, model)
            profile = live_profile
            source = "content_profile_cold_start" if live else "ml_global_prior"

        collab = np.dot(model.item_factors, user_vec) if model.item_factors.size else np.zeros((0,))
        content = np.dot(model.item_content_vectors, profile) if model.item_content_vectors.size else np.zeros((0,))
        live_content = np.dot(model.item_content_vectors, live_profile) if model.item_content_vectors.size else np.zeros((0,))
        collab_norm = _normalize(collab) if collab.size else np.zeros_like(model.popularity)
        content_norm = _normalize(content) if content.size else np.zeros_like(model.popularity)
        live_norm = _normalize(live_content) if live_content.size else np.zeros_like(model.popularity)
        w_collab, w_content, w_live, w_pop, w_rec = self._coerce_blend_weights(model.blend_weights).tolist()
        if not known:
            # For true cold start users, reduce collaborative weight and emphasize profile/content signals.
            collab_shift = min(w_collab, 0.18)
            w_collab -= collab_shift
            w_content += 0.54 * collab_shift
            w_live += 0.46 * collab_shift

        scores = (
            w_collab * collab_norm
            + w_content * content_norm
            + w_live * live_norm
            + w_pop * model.popularity
            + w_rec * model.recency
        )

        if known and interacted:
            # Prefer fresh candidates while still allowing high-affinity rewatches.
            scores[list(interacted)] -= 0.18

        ranked = np.argsort(-scores)[: limit * 4]
        items = []
        for idx in ranked:
            idx = int(idx)
            vid = model.index_to_video[idx]
            video = catalog.get(vid)
            if not video:
                continue
            tags = ["balanced"]
            reason = "ML blend of collaborative and content profile."
            if live_norm[idx] > content_norm[idx] + 0.08:
                tags = ["history-match"]
                reason = "Aligned with your recent watch/search behavior."
            elif content_norm[idx] > collab_norm[idx] + 0.08:
                tags = ["content-match"]
                reason = "Aligned with your search/watch content profile."
            elif collab_norm[idx] > content_norm[idx] + 0.08:
                tags = ["taste-match"]
                reason = "Strong match with users who watch like you."
            if idx in interacted:
                tags.append("continue-interest")
            if float(model.popularity[idx]) >= 0.60:
                tags.append("engaged")
            if float(model.recency[idx]) >= 0.55:
                tags.append("recent")
            items.append(self._item_payload(video=video, rank=len(items) + 1, source=source, score=float(scores[idx]), reason=reason, reason_tags=tags))
            if len(items) >= limit:
                break

        if not items:
            for rank, vid in enumerate(model.fallback_videos[:limit], start=1):
                video = catalog.get(vid)
                if not video:
                    continue
                items.append(self._item_payload(video=video, rank=rank, source="ml_global_prior", score=None, reason="Ranked by global learned preference prior.", reason_tags=["global-prior", "ml"]))

        return {"source": source, "items": items, "trained_at": model.trained_at, "training_summary": model.training_summary}

    def trending(self, limit: int = 20) -> Dict:
        limit = max(1, min(limit, 100))
        catalog = self._catalog()
        if not catalog:
            return {"source": "trending", "items": []}
        ids = list(catalog.keys())
        views = np.array([_safe_float(catalog[v]["view_count"]) for v in ids], dtype=np.float64)
        likes = np.array([_safe_float(catalog[v]["like_count"]) for v in ids], dtype=np.float64)
        comments = np.array([_safe_float(catalog[v]["comment_count"]) for v in ids], dtype=np.float64)
        watch = np.array([_safe_float(catalog[v]["watch_time_total"]) for v in ids], dtype=np.float64)
        now = time.time()
        recency = np.array([math.exp(-math.log(2) * max(1.0, now - catalog[v]["created_at"].timestamp()) / 86400.0 / self.recency_half_life_days) for v in ids], dtype=np.float64)
        scores = 0.52 * _normalize(np.log1p(views)) + 0.23 * _normalize(np.log1p(likes)) + 0.12 * _normalize(np.log1p(comments)) + 0.08 * _normalize(np.log1p(watch)) + 0.05 * _normalize(recency)
        items = [self._item_payload(video=catalog[ids[int(i)]], rank=rank + 1, source="trending", score=float(scores[int(i)]), reason="Strong total engagement momentum.", reason_tags=["trending", "engagement"]) for rank, i in enumerate(np.argsort(-scores)[:limit])]
        return {"source": "trending", "items": items}

    def fresh(self, limit: int = 20) -> Dict:
        limit = max(1, min(limit, 100))
        catalog = self._catalog()
        rows = sorted(catalog.values(), key=lambda row: row["created_at"], reverse=True)[:limit]
        now = time.time()
        items = []
        for rank, row in enumerate(rows, start=1):
            age_days = max(0.0, (now - row["created_at"].timestamp()) / 86400.0)
            score = math.exp(-math.log(2) * age_days / self.recency_half_life_days)
            items.append(self._item_payload(video=row, rank=rank, source="fresh", score=score, reason="Recently uploaded video.", reason_tags=["fresh", "recent"]))
        return {"source": "fresh", "items": items}

    def continue_watching(self, user_id: str, limit: int = 20) -> Dict:
        limit = max(1, min(limit, 100))
        rows = self._fetch_continue_rows(user_id=user_id, limit=limit)
        items = []
        for rank, row in enumerate(rows, start=1):
            duration = max(1.0, _safe_float(row.get("duration_seconds"), 1.0))
            completion = max(_safe_float(row.get("completion_rate")), min(1.0, _safe_float(row.get("last_watch_time_seconds")) / duration))
            progress = int(round(max(0.0, min(1.0, completion)) * 100))
            reason = "Continue from where you left off." if progress < 80 else "Almost finished. Resume to complete this video."
            items.append(self._item_payload(video=row, rank=rank, source="continue_watching", score=completion, reason=reason, reason_tags=["continue", "unfinished"], extras={"progress_percent": progress, "last_watched_at": _to_iso(row.get("last_watched_at"))}))
        return {"source": "continue_watching", "items": items}

    def model_health(self) -> Dict:
        with self._lock:
            model = self._model
        if model is None:
            return {"ready": False}
        return {
            "ready": True,
            "trained_at": model.trained_at,
            "training_summary": model.training_summary,
            "users": len(model.user_to_index),
            "videos": len(model.video_to_index),
            "content_dim": int(model.item_content_vectors.shape[1]) if model.item_content_vectors.ndim == 2 else self.content_vector_dim,
            "blend_weights": {
                "collaborative": float(model.blend_weights[0]),
                "content_profile": float(model.blend_weights[1]),
                "live_profile": float(model.blend_weights[2]),
                "popularity": float(model.blend_weights[3]),
                "recency": float(model.blend_weights[4]),
            },
        }
