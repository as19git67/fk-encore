"""FastAPI application entry point."""

from __future__ import annotations

# CPU thread tuning. OMP / MKL / OpenBLAS read these env vars on library load
# (not on first use), so they MUST be set before torch / numpy are imported
# anywhere in the process — including transitively via FastAPI handlers.
# Default: half the logical CPUs, which approximates the physical-core count
# on Intel HT and avoids E-core oversubscription on Alder/Raptor Lake hybrids
# (a 12600K reports 16 logical → 8 threads here, which is fine; the deploy
# pins the container to the 12 P-core threads via `cpuset` and sets
# EMBED_NUM_THREADS=6 for an exact P-core mapping).
import os as _os

def _default_thread_count() -> int:
    return max(1, (_os.cpu_count() or 2) // 2)

_EMBED_THREADS = int(_os.environ.get("EMBED_NUM_THREADS") or _default_thread_count())
_os.environ.setdefault("OMP_NUM_THREADS", str(_EMBED_THREADS))
_os.environ.setdefault("MKL_NUM_THREADS", str(_EMBED_THREADS))
_os.environ.setdefault("OPENBLAS_NUM_THREADS", str(_EMBED_THREADS))

import logging
import logging.config

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pillow_heif import register_heif_opener

register_heif_opener()

# Now safe to touch torch. set_num_interop_threads must be called before any
# ATen op runs — doing it here at import time satisfies that contract.
import torch
torch.set_num_threads(_EMBED_THREADS)
try:
    torch.set_num_interop_threads(1)
except RuntimeError:
    # Already initialised (e.g. when uvicorn reloads). Safe to ignore.
    pass

from app.api.endpoints import router
from app.config import settings
from app.db.database import ensure_database_exists, run_migrations

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
    await ensure_database_exists()
    await run_migrations()
    if not settings.lazy_load_models:
        logger.info("Preloading models...")
        from app.services.embedding_service import CLIPEmbedder, DINOv2Embedder
        await CLIPEmbedder.preload(model_name=settings.clip_model_name, pretrained=settings.clip_pretrained)
        await DINOv2Embedder.preload(model_name=settings.dino_model_name)
    logger.info(
        "Embedding Service started (log_level=%s, lazy_load_models=%s, threads=%d).",
        settings.log_level, settings.lazy_load_models, _EMBED_THREADS,
    )
