# ScalaStream ML Recommendation Approach

This document explains why machine learning is used, what data is used, and how personalization improves user experience.

## Why Machine Learning Is Used

A static or rule-only feed cannot adapt to each user’s evolving interests. ScalaStream uses ML so ranking can:

- Learn latent taste similarity between users and videos.
- Adapt from observed behavior (watch depth, likes, comments, searches).
- Handle cold-start users/videos better by blending collaborative and content signals.

This directly satisfies the competition requirement that recommendations must be ML-based (not static logic).

## Data Used for Training and Ranking

The recommender uses interaction and content data from PostgreSQL:

- `video_views`:
  - `watch_time_seconds` / `watch_delta_seconds`
  - `completion_rate`
- `video_likes`:
  - implicit positive preference
- `video_comments`:
  - stronger engagement signal
- `videos`:
  - `title`, `description`, `created_at`, `duration_seconds`
  - aggregate engagement context from `video_aggregates`
- `user_search_events`:
  - search text + recency for intent modeling

## Feature Engineering

Per user-video interaction, features include:

- `watch_time_ratio = watch_time_seconds / duration_seconds` (clamped)
- `completion_rate`
- `like_flag`
- `comment_flag`
- `recency_weight` (exponential decay from upload time)

The interaction strength score used to form positives is:

`score = 1.45*watch_ratio + 1.25*completion + 1.35*like + 1.10*comment + 0.65*recency`

Content features:

- Video text vectors from tokenized `title + description` (hashed embedding).
- User search profile vectors from recent search text with time decay.

## Model Architecture (Hybrid)

ScalaStream trains a hybrid recommender:

1. Collaborative layer:
   - Pairwise BPR-style matrix factorization (user/item latent vectors).
   - Learns what users with similar behavior tend to watch.
2. Content layer:
   - Text embedding vectors for items and user profiles.
   - Helps cold-start and sparse-interaction users.
3. Supervised score calibration layer:
   - A logistic calibration model is trained on sampled positive/negative user-item pairs.
   - It learns blend weights for: collaborative score, offline content score, live profile score, popularity prior, and recency prior.
4. Popularity/recency priors:
   - Used as informative ranking signals and for fallback support.

At serving time, final scores are a weighted blend of:

- collaborative affinity
- offline content profile affinity
- live profile affinity (recent watch + search)
- popularity prior
- recency prior

The blend coefficients are not hardcoded constants anymore; they are learned during training by minimizing logistic log-loss on sampled ranking data.

## Training and Serving Workflow

- Service: `recommendation-service` (`FastAPI`)
- Auto training: scheduled interval (`TRAIN_INTERVAL_SECONDS`, default 300s)
- Manual training: `POST /feed/train` (UI button: **Retrain Model**)
- Personalized feed API: `GET /feed/recommended?userId=...&limit=...`
- Additional feed modes: `trending`, `fresh`, `continue_watching`

The model persists to `model_store` (`model.npz` + `meta.json`) so retraining output survives service restarts in running containers.

## Cold-Start Behavior (Still ML-Based)

For users with low or no history:

- Build a live content profile from search history (if available).
- Blend with global learned vectors and learned priors.
- Return ML-ranked items from learned embeddings, not static hardcoded lists.

## Why This Is Not Rule-Based

Although the system has multiple feed modes, the personalized feed (`/feed/recommended`) is not a simple rule filter:

- It trains latent vectors from behavioral interactions.
- It computes dot-product affinity scores in learned embedding spaces.
- It trains a supervised logistic calibration layer to learn score-combination weights from data.
- It uses search/watch content vectors learned from real interaction text.

Therefore ranking is model-driven rather than static if/else recommendation rules.

## Training Diagnostics

The training summary now reports:

- `blend_samples`: number of sampled pairs used for calibration.
- `blend_logloss`: logistic calibration loss.
- `blend_auc`: sampled pairwise AUC for separation quality.

These metrics help demonstrate that the model is learned and measurable, not manually tuned.

## User Experience Impact

ML personalization improves UX by:

- Prioritizing videos aligned with each user’s watch and search intent.
- Reducing irrelevant recommendations as behavior evolves.
- Supporting resume patterns through continue-watching and retention-aware signals.
- Producing visibly different ranked feeds for users with different interaction histories.

## Competition Requirement Mapping

- Why ML is used: covered in this document (`Why Machine Learning Is Used`).
- What data is utilized: covered in `Data Used` + `Feature Engineering`.
- How recommendations enhance UX: covered in `User Experience Impact`.
