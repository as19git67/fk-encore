"""Aesthetic scoring service: Q-Align on a borrowed GPU.

Stage 1 of ``documentation/plans/foto-aesthetik.md``. The service holds no
model at rest. The nightly job in the app lends it the GPU (the llm-service
has moved Gemma 4 to the CPU by then), calls :http:post:`/load`, scores the
backlog through :http:post:`/score`, and calls :http:post:`/unload` before
the GPU goes back. :http:get:`/status` says which of those states the
service is in; :http:get:`/healthz` is the container probe and stays open.

State machine::

    unloaded ──/load──▶ loading ──▶ loaded ──/unload──▶ unloading ──▶ unloaded
                           │                                    ▲
                           └──(failure)──▶ error ──/load or /unload┘

Load and unload run on their own thread and answer 202 at once: a
multi-gigabyte load takes minutes, longer than any sensible HTTP timeout,
and the job polls ``/status`` the way the app already polls the
llm-service's ``/reload/status``. Scoring runs on a single-worker executor,
so two requests never share the card.
"""

from __future__ import annotations

import asyncio
import functools
import io
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Any, Callable

from fastapi import FastAPI, File, HTTPException, UploadFile, status
from PIL import Image

from scorer import Scorer, ScorerError, scorer_from_env
from service_auth import install_service_auth

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("aesthetic-service")

# A photo larger than this is downscaled before it reaches the model. Q-Align
# resizes to its own 448 px input anyway; decoding a 50-megapixel original
# just to throw the pixels away is the only cost worth avoiding here.
MAX_EDGE = int(os.environ.get("AESTHETIC_MAX_EDGE", "1024"))

STATES = ("unloaded", "loading", "loaded", "unloading", "error")


class _State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.state = "unloaded"
        self.error: str | None = None
        self.changed_at = time.time()
        self.loaded_at: float | None = None
        self.scored = 0

    def set(self, state: str, *, error: str | None = None) -> None:
        assert state in STATES
        with self.lock:
            self.state = state
            self.error = error
            self.changed_at = time.time()
            if state == "loaded":
                self.loaded_at = self.changed_at
            elif state == "unloaded":
                self.loaded_at = None


_state = _State()

# Built lazily so the tests can swap the factory for a fake before the first
# use, and so importing this module needs neither torch nor a GPU.
_scorer: Scorer | None = None
_scorer_factory: Callable[[], Scorer] = scorer_from_env


def _get_scorer() -> Scorer:
    global _scorer
    if _scorer is None:
        _scorer = _scorer_factory()
    return _scorer


# One thread for load/unload (never two lifecycle changes at once) and one
# for inference (never two score calls on the card at once). They are
# separate so a status poll during a load is never queued behind it.
_lifecycle_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="aesthetic-lifecycle")
_inference_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="aesthetic-inference")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("aesthetic-service ready; no model loaded (max_edge=%d)", MAX_EDGE)
    yield
    if _state.state in {"loaded", "error"} and _scorer is not None:
        try:
            _scorer.unload()
        except Exception:  # pragma: no cover
            log.exception("unload on shutdown failed")


app = FastAPI(
    title="FK-Encore Aesthetic Service",
    description="Scores photo aesthetics with Q-Align on a GPU lent for the night.",
    version="0.1.0",
    lifespan=lifespan,
)
install_service_auth(app)


# ── lifecycle ──────────────────────────────────────────────────────────────


def _load_worker() -> None:
    try:
        _get_scorer().load()
    except Exception as exc:
        log.exception("load failed")
        _state.set("error", error=f"{type(exc).__name__}: {exc}")
        # Whatever the failed load left behind must not stay on the card.
        try:
            _get_scorer().unload()
        except Exception:  # pragma: no cover
            pass
        return
    _state.set("loaded")


def _unload_worker() -> None:
    try:
        _get_scorer().unload()
    except Exception as exc:
        log.exception("unload failed")
        _state.set("error", error=f"{type(exc).__name__}: {exc}")
        return
    _state.set("unloaded")


def _status_view() -> dict[str, Any]:
    scorer = _scorer
    vram = scorer.vram_used_bytes() if scorer is not None and _state.state == "loaded" else None
    return {
        "state": _state.state,
        "error": _state.error,
        "model_id": scorer.model_id if scorer is not None else os.environ.get("AESTHETIC_MODEL_ID"),
        "version": scorer.version if scorer is not None else None,
        "loaded_at": _state.loaded_at,
        "changed_at": _state.changed_at,
        "scored": _state.scored,
        "vram_used_bytes": vram,
    }


@app.get("/healthz")
@app.get("/health")
async def healthz() -> dict[str, Any]:
    # "ok" in every state the service can serve requests from: an unloaded
    # scorer is the normal daytime condition, not a failure.
    return {"status": "ok", "state": _state.state}


@app.get("/status")
async def get_status() -> dict[str, Any]:
    return _status_view()


@app.post("/load", status_code=status.HTTP_202_ACCEPTED)
async def load_model() -> dict[str, Any]:
    with _state.lock:
        current = _state.state
    if current == "loaded":
        return _status_view()
    if current in {"loading", "unloading"}:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=f"scorer is {current}")
    _state.set("loading")
    _lifecycle_executor.submit(_load_worker)
    return _status_view()


@app.post("/unload", status_code=status.HTTP_202_ACCEPTED)
async def unload_model() -> dict[str, Any]:
    with _state.lock:
        current = _state.state
    if current == "unloaded":
        return _status_view()
    if current in {"loading", "unloading"}:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=f"scorer is {current}")
    _state.set("unloading")
    _lifecycle_executor.submit(_unload_worker)
    return _status_view()


# ── scoring ────────────────────────────────────────────────────────────────


def _prepare(content: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(content))
        image.load()
    except Exception as exc:
        raise HTTPException(
            422, detail=f"cannot read image: {exc}"
        ) from exc
    image = image.convert("RGB")
    longest = max(image.size)
    if longest > MAX_EDGE:
        scale = MAX_EDGE / longest
        image = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.Resampling.LANCZOS,
        )
    return image


def _score_sync(image: Image.Image) -> dict[str, Any]:
    started = time.monotonic()
    scores = _get_scorer().score(image)
    with _state.lock:
        _state.scored += 1
    return {
        "aesthetics": round(scores.aesthetics, 4),
        "quality": round(scores.quality, 4),
        "scale": {"min": 1.0, "max": 5.0},
        "version": _get_scorer().version,
        "model_id": _get_scorer().model_id,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
    }


@app.post("/score")
async def score(file: UploadFile = File(...)) -> dict[str, Any]:
    with _state.lock:
        current = _state.state
    if current != "loaded":
        # 503 rather than 409: to the caller the service is temporarily
        # unable to serve, and the fix is a /load, not a different request.
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"scorer is {current}; POST /load first",
        )
    content = await file.read()
    image = _prepare(content)
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(
            _inference_executor, functools.partial(_score_sync, image)
        )
    except ScorerError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
