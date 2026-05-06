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
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

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


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    # ── Check & Download Models ─────────────────────────────────────────────
    models_dir = Path(_os.environ.get("MODELS_DIR", "/models"))
    hf_cache = Path(_os.environ.get("HF_HOME", str(models_dir / "hf-cache")))
    onnx_dir = models_dir / "onnx"

    # 1. Base models (Torch/HF) - required by both backends
    # We check for the hub directory as a proxy for the cache being populated.
    hub_dir = hf_cache / "hub"
    if not hub_dir.exists() or not any(hub_dir.iterdir()):
        logger.info("Models not found in %s. Attempting to download...", hf_cache)
        script_path = Path("/usr/local/bin/download_model.sh")
        if not script_path.exists():
            script_path = Path(__file__).parent.parent / "download_model.sh"

        if script_path.exists():
            try:
                subprocess.run([str(script_path)], check=True)
            except Exception as e:
                logger.error("Auto-download failed: %s", e)
                # We don't raise here yet if it's lazy loading, but usually it's better to fail early
                if not settings.lazy_load_models:
                    raise RuntimeError("Auto-download failed and preloading is enabled.") from e
        else:
            logger.warning("Download script not found at %s. Skipping auto-download.", script_path)

    # 2. ONNX models - only if backend is set to onnx
    if settings.embed_backend.lower() == "onnx":
        clip_onnx = onnx_dir / "clip_image_int8.onnx"
        if not clip_onnx.exists():
            logger.info("ONNX models not found in %s. Attempting to optimize...", onnx_dir)
            opt_script = Path("/usr/local/bin/optimize_models.sh")
            if not opt_script.exists():
                opt_script = Path(__file__).parent.parent / "optimize_models.sh"

            if opt_script.exists():
                try:
                    subprocess.run([str(opt_script)], check=True)
                except Exception as e:
                    logger.error("Auto-optimization failed: %s", e)
                    if not settings.lazy_load_models:
                        raise RuntimeError("Auto-optimization failed and preloading is enabled.") from e
            else:
                logger.warning("Optimization script not found at %s.", opt_script)

    # ── Database & Preloading ───────────────────────────────────────────────
    await ensure_database_exists()
    await run_migrations()

    if not settings.lazy_load_models:
        logger.info("Preloading models (backend=%s)...", settings.embed_backend)
        from app.services.embedding_service import clip_embedder_class, dino_embedder_class
        await clip_embedder_class().preload(
            model_name=settings.clip_model_name, pretrained=settings.clip_pretrained
        )
        await dino_embedder_class().preload(model_name=settings.dino_model_name)

    logger.info(
        "Embedding Service started (backend=%s, log_level=%s, lazy_load_models=%s, threads=%d).",
        settings.embed_backend, settings.log_level, settings.lazy_load_models, _EMBED_THREADS,
    )

    yield


app = FastAPI(
    title="Embedding Service",
    description="Generates and stores OpenCLIP + DINOv2 embeddings for photos.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
