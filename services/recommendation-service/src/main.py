import logging
import os
from contextlib import asynccontextmanager

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, HTTPException, Query

from .recommender import RecommenderEngine

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("recommendation-service")

PORT = int(os.getenv("PORT", "8082"))
DATABASE_URL = os.getenv("DATABASE_URL")
TRAIN_INTERVAL_SECONDS = int(os.getenv("TRAIN_INTERVAL_SECONDS", "300"))
MODEL_DIR = os.getenv("MODEL_DIR", "/app/model_store")
RECENCY_HALF_LIFE_DAYS = float(os.getenv("RECENCY_HALF_LIFE_DAYS", "10"))

engine = RecommenderEngine(
    db_url=DATABASE_URL,
    model_dir=MODEL_DIR,
    recency_half_life_days=RECENCY_HALF_LIFE_DAYS,
)
scheduler = BackgroundScheduler()


def train_job():
    try:
        summary = engine.train()
        logger.info("Model training complete: %s", summary)
    except Exception as exc:  # pylint: disable=broad-except
        logger.exception("Model training failed: %s", exc)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    scheduler.add_job(
        train_job,
        "interval",
        seconds=TRAIN_INTERVAL_SECONDS,
        id="retrain-job",
        replace_existing=True,
    )
    scheduler.start()
    train_job()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="ScalaStream Recommendation Service", lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": True, "service": "recommendation-service", "model": engine.model_health()}


@app.post("/train")
def train():
    summary = engine.train()
    return {"ok": True, "summary": summary}


@app.post("/feed/train")
def train_via_feed_prefix():
    summary = engine.train()
    return {"ok": True, "summary": summary}


def _base_feed_payload(limit: int, source: str, items, user_id: str = ""):
    model = engine.model_health()
    return {
        "user_id": user_id or None,
        "limit": limit,
        "source": source,
        "trained_at": model.get("trained_at"),
        "training_summary": model.get("training_summary"),
        "items": items,
        "features": [
            "watch_time_ratio",
            "completion_rate",
            "like_flag",
            "comment_flag",
            "recency_weight",
            "search_history_signal",
            "content_similarity_signal",
            "collaborative_embedding_score",
            "logistic_blend_calibration",
        ],
    }


@app.get("/feed/recommended")
def recommended_feed(userId: str = Query(..., min_length=1), limit: int = Query(20, ge=1, le=100)):
    try:
        response = engine.recommend(user_id=userId, limit=limit)
        payload = _base_feed_payload(
            limit=limit,
            source=response.get("source", "recommended"),
            items=response.get("items", []),
            user_id=userId,
        )
        payload["trained_at"] = response.get("trained_at", payload["trained_at"])
        payload["training_summary"] = response.get("training_summary", payload["training_summary"])
        return payload
    except Exception as exc:  # pylint: disable=broad-except
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/feed/trending")
def trending_feed(limit: int = Query(20, ge=1, le=100)):
    try:
        response = engine.trending(limit=limit)
        return _base_feed_payload(
            limit=limit,
            source=response.get("source", "trending"),
            items=response.get("items", []),
        )
    except Exception as exc:  # pylint: disable=broad-except
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/feed/fresh")
def fresh_feed(limit: int = Query(20, ge=1, le=100)):
    try:
        response = engine.fresh(limit=limit)
        return _base_feed_payload(
            limit=limit,
            source=response.get("source", "fresh"),
            items=response.get("items", []),
        )
    except Exception as exc:  # pylint: disable=broad-except
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/feed/continue")
def continue_feed(userId: str = Query(..., min_length=1), limit: int = Query(20, ge=1, le=100)):
    try:
        response = engine.continue_watching(user_id=userId, limit=min(limit, 1))
        payload = _base_feed_payload(
            limit=min(limit, 1),
            source=response.get("source", "continue_watching"),
            items=response.get("items", []),
            user_id=userId,
        )
        payload["message"] = "Most recent unfinished video for quick resume."
        return payload
    except Exception as exc:  # pylint: disable=broad-except
        raise HTTPException(status_code=500, detail=str(exc)) from exc
