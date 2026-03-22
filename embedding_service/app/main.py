"""FastAPI application entry point."""

from __future__ import annotations

import logging
import logging.config

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pillow_heif import register_heif_opener

register_heif_opener()

from app.api.endpoints import router
from app.config import settings
from app.db.database import run_migrations

logging.basicConfig(
    level=settings.log_level.upper(),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Embedding Service",
    description="Generates and stores OpenCLIP + DINOv2 embeddings for photos.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.on_event("startup")
async def _on_startup() -> None:
    await run_migrations()
    logger.info("Embedding Service started (log_level=%s).", settings.log_level)
