"""FastAPI service fronting a local Llama (GGUF) classifier and a
sentence-transformers embedder.

The process expects both models to exist on disk *before* startup — see
``download_model.sh``. Model files live in a bind-mounted volume, not in the
image. Startup behaviour:

* ``Llama`` mmap's the GGUF file from disk (no network).
* ``SentenceTransformer`` loads the embedder from ``SENTENCE_TRANSFORMERS_HOME``
  (also no network, provided ``download_model.sh`` ran at least once).

The two exposed endpoints are :http:post:`/classify` (structured JSON output)
and :http:post:`/embed`, plus :http:get:`/healthz` for compose.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import os
import re
import resource
import signal
import time
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Callable, TypeVar

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from llama_supervisor import LlamaServerProcess, terminate_own_process
from llm_config import ConfigError, LlmConfig, clear_active, load_active, save_active
from model_downloads import (
    DownloadError,
    DownloadManager,
    DownloadTarget,
    delete_model_file,
    disk_usage,
    filename_from_url,
    list_model_files,
)

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
log = logging.getLogger("llm-service")


# ─── Config ────────────────────────────────────────────────────────────────────

# ``os.environ.get(key, default)`` only falls back to the default when the key
# is *absent* — a key that is set to "" still returns "", and int("") blows up.
# Compose passes ``${VAR:-}`` for unset overrides, which lands here as "", so
# unwrap that explicitly.
def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return int(raw)


MODELS_DIR = Path(os.environ.get("MODELS_DIR") or "/models")

# The model-facing knobs below are no longer read one by one from the
# environment: they arrive as an :class:`LlmConfig`, which comes either from
# the environment (the compose/.env case, unchanged) or from a configuration
# activated through the admin UI and persisted on the models volume.
#
# They stay module-level globals because every read site in this file — the
# /classify token budget, /healthz, both loaders — already treats them as such.
# :func:`_apply_config` is the single place that rebinds them, and it only runs
# at startup and under the reload lock, so no request observes a half-applied
# config.
_BOOT_CONFIG = LlmConfig.from_env()

LLM_MODEL_PATH = _BOOT_CONFIG.model_path
LLM_CTX = _BOOT_CONFIG.ctx
LLM_THREADS = _BOOT_CONFIG.threads
LLM_GPU_LAYERS = _BOOT_CONFIG.gpu_layers
LLM_ACCELERATOR = _BOOT_CONFIG.accelerator
# ── Prefill / KV tuning ───────────────────────────────────────────────────────
#
# The classifier prompt is dominated by a fixed prefix — system prompts plus the
# taxonomy/doctype/tax-section outline *with* hints is ~15k tokens before the
# document text is appended. Prefill therefore dominates wall time per
# /classify, and the knobs that govern prefill matter more here than the
# decode-side ones.
#
# ``n_batch``/``n_ubatch``: llama.cpp evaluates the prompt in batches; the
# upstream default of 512 leaves GPU prefill throughput unused at five-figure
# prompt lengths. Defaults kept at llama.cpp's own value so the CPU image is
# unaffected — the CUDA image raises them via ENV.
LLM_BATCH = _BOOT_CONFIG.batch
LLM_UBATCH = _BOOT_CONFIG.ubatch
# FlashAttention: fused attention kernel, a real win at long context on CUDA and
# a prerequisite for quantising the V side of the KV cache. Off by default
# (llama.cpp's default); the CUDA image turns it on.
LLM_FLASH_ATTN = _BOOT_CONFIG.flash_attn
# KV-cache element type. Qwen3-14B spends 160 KiB of KV per token (40 layers ×
# 8 KV heads × 128 dims × [K+V] × 2 bytes) — 2.8 GiB at LLM_CTX=18500, the
# largest VRAM item after the weights themselves. "q8_0" halves that at
# negligible quality cost, buying headroom for a larger window. Quantising the
# V cache requires LLM_FLASH_ATTN=1.
LLM_KV_TYPE = _BOOT_CONFIG.kv_type

# ggml_type enum values (ggml.h). Hard-coded as a fallback because the symbol
# names are not guaranteed to be re-exported at the llama_cpp package root
# across the two pinned versions (CPU image 0.3.2, CUDA image 0.3.31); we
# prefer the module attribute when it exists.
_GGML_KV_TYPES: dict[str, tuple[str, int]] = {
    "f16": ("GGML_TYPE_F16", 1),
    "q8_0": ("GGML_TYPE_Q8_0", 8),
    "q5_1": ("GGML_TYPE_Q5_1", 7),
    "q5_0": ("GGML_TYPE_Q5_0", 6),
    "q4_0": ("GGML_TYPE_Q4_0", 2),
}

LLM_EMBED_DEVICE = (os.environ.get("LLM_EMBED_DEVICE") or "cpu").lower()
# sentence-transformers' own default; raising it trades VRAM/RAM for fewer,
# bigger chunks when a caller sends large text lists to /embed.
LLM_EMBED_BATCH_SIZE = _env_int("LLM_EMBED_BATCH_SIZE", 32)

# ── Backend selection ─────────────────────────────────────────────────────────
#
# "inproc": the historical path — llama-cpp-python mmaps the GGUF into this
#   process. Default, and what the CPU image ships.
# "server": a llama.cpp ``llama-server`` sidecar owns the model and we talk to
#   it over HTTP (see llama_server.py). The GPU image uses this, because
#   MoE expert offload (``--n-cpu-moe``) is reachable only from llama.cpp
#   proper — the Python binding does not expose the tensor-buffer overrides it
#   is built on.
#
# The embedder is unaffected either way: sentence-transformers keeps running
# in this process in both modes.
LLM_BACKEND = _BOOT_CONFIG.backend
LLM_SERVER_URL = _BOOT_CONFIG.server_url
# Startup deadline for the sidecar. A MoE model with most of its experts bound
# for system RAM reads tens of GB off disk on a cold page cache, so this is
# minutes, not seconds — and it gates the compose healthcheck, hence an env var.
LLM_SERVER_READY_TIMEOUT = _BOOT_CONFIG.server_ready_timeout
# Per-request deadline against the sidecar. Must stay above the caller's own
# LLM_SERVICE_TIMEOUT_MS (documents/llm-client.ts) so the app gives up first and
# we don't leave a half-finished generation behind.
LLM_SERVER_REQUEST_TIMEOUT = _BOOT_CONFIG.server_request_timeout
# Expert-offload split: the number of leading layers whose MoE expert tensors
# live in system RAM. Surfaced in /healthz so a deployment's split is visible
# without exec'ing into the container.
LLM_NCMOE = _BOOT_CONFIG.n_cpu_moe
LLM_REASONING = _BOOT_CONFIG.reasoning

# LLM_ACCELERATOR / LLM_BACKEND / LLM_KV_TYPE are validated by
# LlmConfig.validate(), which runs on both the environment and the API paths so
# the two reject the same values. The embedder is not part of that config — it
# is unaffected by a model swap — so it keeps its own check here.
if LLM_EMBED_DEVICE not in {"cpu", "cuda", "auto"}:
    raise ValueError("LLM_EMBED_DEVICE must be 'cpu', 'cuda', or 'auto'")

# Deterministic backstop for a known small-model failure mode: when the
# classifier doesn't actually see a tax-section match, it sometimes returns
# the *entire* list of sections it was offered (high-confidence "dump-all").
# Almost every legitimate document belongs to one section, very rarely to
# two or three. More than this threshold is treated as a confused output —
# we drop the tax assignment so it doesn't contaminate the user's tax view.
# Set to 0 to disable the backstop.
TAX_SECTIONS_MAX = _env_int("TAX_SECTIONS_MAX", 4)

# Plausible range for a document's tax year. Household documents legitimately
# span decades, so the lower bound is generous — it exists to catch the
# classifier grabbing an unrelated four-digit number off the page (a birth year
# next to "geb.", a street number, a customer id), not to police old documents.
# Mirrored by TAX_YEAR_MIN/TAX_YEAR_MAX in documents/llm-client.ts and by the
# documents_tax_year_range CHECK constraint (migration 0140).
TAX_YEAR_MIN = 1970
TAX_YEAR_MAX = 2100

# Upper bound (characters) on the document text considered by /classify. This
# is a cheap pre-cap before the token-budget guard further shrinks the text to
# fit n_ctx. Keep it >= the caller's DOCUMENTS_CLASSIFY_CHAR_LIMIT, otherwise a
# raised app-side limit would be silently re-clipped here. Configurable so the
# document char budget can be raised in lockstep without a code change once a
# larger LLM_CTX gives the context window room for longer documents.
CLASSIFY_TEXT_CHAR_LIMIT = _env_int("CLASSIFY_TEXT_CHAR_LIMIT", 6000)

EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "intfloat/multilingual-e5-base")
# sentence-transformers respects this env var as its on-disk cache location.
os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", str(MODELS_DIR / "st-cache"))
os.environ.setdefault("HF_HOME", str(MODELS_DIR / "hf-cache"))


# ─── Lifespan: load models once at startup ─────────────────────────────────────

_state: dict[str, Any] = {
    "llm": None,
    "embedder": None,
    "llm_accelerator": None,
    "embedder_device": None,
    "cuda_device_name": None,
    # Resolved once at startup — see _resolve_classify_response_format.
    "classify_response_format": None,
    # The LlmConfig currently in force, and where it came from ("env" or "file").
    "config": _BOOT_CONFIG,
    "config_source": "env",
}

def _handle_unexpected_exit(status: int) -> None:
    """Route a llama-server crash to the right recovery.

    Outside a reload, nothing owns the failure but compose's restart policy —
    bring the whole container down, same as always. *During* a reload
    (`_reload_running`), `_reload_worker`'s except block is that owner: it
    stops whatever is left, restores the configuration that was working, and
    reloads it. Killing the process here as well would win the race against
    that rollback every time — the watcher notices a crash within
    milliseconds, long before `_apply_config`/`_load_llm` for the previous
    config could even start — turning a recoverable bad reload into a full
    outage. still_starting (see `_load_server_llm`) is what makes the
    rollback path fast rather than a wait for the full ready-timeout.
    """

    if _reload_running:
        log.error(
            "llama-server died (status=%s) during a reload — leaving recovery to the "
            "reload worker instead of restarting the container",
            status,
        )
        return
    terminate_own_process(status)


# Owns the llama-server subprocess for the server backend. Created eagerly so
# /healthz and the reload machinery can ask about it before anything is loaded;
# it starts no process until told to.
_llama_server = LlamaServerProcess(on_unexpected_exit=_handle_unexpected_exit)

# Downloads of model files requested at runtime through the admin UI. The
# cold-start download still belongs to download_model.sh.
_downloads = DownloadManager(MODELS_DIR)


def _apply_config(cfg: LlmConfig, *, source: str) -> None:
    """Publish *cfg* as this module's live configuration.

    Rebinding module globals is deliberate: every read site in this file
    already reads these names, and funnelling the writes through one function
    keeps that true without threading a config object through the request
    handlers. Only startup and the reload lock call it, so no in-flight request
    can see a mix of old and new values.
    """

    global LLM_MODEL_PATH, LLM_CTX, LLM_THREADS, LLM_GPU_LAYERS, LLM_ACCELERATOR
    global LLM_BATCH, LLM_UBATCH, LLM_FLASH_ATTN, LLM_KV_TYPE
    global LLM_BACKEND, LLM_SERVER_URL, LLM_NCMOE, LLM_REASONING
    global LLM_SERVER_READY_TIMEOUT, LLM_SERVER_REQUEST_TIMEOUT

    LLM_MODEL_PATH = cfg.model_path
    LLM_CTX = cfg.ctx
    LLM_THREADS = cfg.threads
    LLM_GPU_LAYERS = cfg.gpu_layers
    LLM_ACCELERATOR = cfg.accelerator
    LLM_BATCH = cfg.batch
    LLM_UBATCH = cfg.ubatch
    LLM_FLASH_ATTN = cfg.flash_attn
    LLM_KV_TYPE = cfg.kv_type
    LLM_BACKEND = cfg.backend
    LLM_SERVER_URL = cfg.server_url
    LLM_NCMOE = cfg.n_cpu_moe
    LLM_REASONING = cfg.reasoning
    LLM_SERVER_READY_TIMEOUT = cfg.server_ready_timeout
    LLM_SERVER_REQUEST_TIMEOUT = cfg.server_request_timeout

    _state["config"] = cfg
    _state["config_source"] = source


def _resolve_embed_device(torch: Any) -> str:
    """Resolve and validate the sentence-transformer execution device."""
    cuda_available = bool(torch.cuda.is_available())
    if LLM_EMBED_DEVICE == "cuda" and not cuda_available:
        raise RuntimeError(
            "LLM_EMBED_DEVICE=cuda was requested, but PyTorch cannot access CUDA"
        )
    if LLM_EMBED_DEVICE == "auto":
        return "cuda" if cuda_available else "cpu"
    return LLM_EMBED_DEVICE


def _rss_mb() -> float:
    """Resident-set size of the current process in MB. Linux ``ru_maxrss`` is
    reported in KB; on macOS it would be bytes, but the container target is
    Linux so we don't bother distinguishing."""

    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def _ggml_type(llama_cpp: Any, name: str) -> int:
    """Resolve a ggml type name to its enum value, preferring the binding's own
    constant over our hard-coded fallback."""

    symbol, fallback = _GGML_KV_TYPES[name]
    value = getattr(llama_cpp, symbol, None)
    return int(value) if isinstance(value, int) else fallback


def _optional_llama_kwargs(llama_cpp: Any, llama_cls: Any) -> dict[str, Any]:
    """Map the prefill/KV tuning knobs onto whatever ``Llama.__init__`` the
    installed llama-cpp-python actually accepts.

    The two images pin different versions (CPU 0.3.2, CUDA 0.3.31) and llama.cpp
    reworked the FlashAttention switch from a bool into a tri-state enum in
    between, so the parameter set is not stable across them. Anything the
    installed signature does not know is dropped with a warning: a *tuning*
    parameter must never be the reason the service fails to start.
    """

    import inspect

    try:
        params = inspect.signature(llama_cls.__init__).parameters
    except (TypeError, ValueError):  # pragma: no cover — C-extension shims
        log.warning("cannot introspect Llama.__init__; skipping tuning kwargs")
        return {}

    kwargs: dict[str, Any] = {}

    for env_name, param, value in (
        ("LLM_BATCH", "n_batch", LLM_BATCH),
        ("LLM_UBATCH", "n_ubatch", LLM_UBATCH),
    ):
        if param in params:
            kwargs[param] = value
        elif value != 512:
            log.warning("%s set but llama-cpp-python has no %s parameter", env_name, param)

    if LLM_FLASH_ATTN:
        if "flash_attn" in params:
            kwargs["flash_attn"] = True
        elif "flash_attn_type" in params:
            # llama.cpp's tri-state: AUTO=-1, DISABLED=0, ENABLED=1.
            enabled = getattr(llama_cpp, "LLAMA_FLASH_ATTN_TYPE_ENABLED", 1)
            kwargs["flash_attn_type"] = int(enabled)
        else:
            log.warning(
                "LLM_FLASH_ATTN=1 but llama-cpp-python exposes neither "
                "flash_attn nor flash_attn_type; running without it"
            )

    if LLM_KV_TYPE != "f16":
        ggml = _ggml_type(llama_cpp, LLM_KV_TYPE)
        for param in ("type_k", "type_v"):
            if param in params:
                kwargs[param] = ggml
            else:
                log.warning("LLM_KV_TYPE set but llama-cpp-python has no %s parameter", param)
        if not LLM_FLASH_ATTN:
            log.warning(
                "LLM_KV_TYPE=%s without LLM_FLASH_ATTN=1: llama.cpp cannot use a "
                "quantised V cache without flash attention and may fall back or fail",
                LLM_KV_TYPE,
            )

    return kwargs


def _resolve_classify_response_format() -> dict[str, Any]:
    """Decide once, at startup, whether the installed binding can turn
    ``_CLASSIFY_JSON_SCHEMA`` into a grammar — and fall back to the plain
    ``json_object`` format if it cannot.

    Worth the ceremony because the failure mode is otherwise severe and silent:
    ``create_chat_completion`` converts the schema on every call, so a schema
    this build's converter chokes on (union types like ``["string", "null"]``
    are the likely candidate on older ports) would make *every* /classify raise
    — which the handler turns into a 500, which the app's llm-client treats as
    "service unavailable" and defers for an unbounded retry. Every document
    would silently stop being classified.

    We only degrade on positive evidence of a problem. If the converter itself
    cannot be located we keep the schema and say so, rather than throwing the
    fix away because of a moved import path.

    Not applicable to the server backend: there the schema travels as JSON and
    llama-server builds the grammar itself, so there is no local converter to
    pre-flight — and llama_cpp may not even be installed.
    """

    if LLM_BACKEND == "server":
        return _CLASSIFY_RESPONSE_FORMAT

    try:
        from llama_cpp.llama_grammar import LlamaGrammar
    except Exception:
        log.warning(
            "could not import LlamaGrammar to pre-verify the /classify JSON schema; "
            "using it unverified"
        )
        return _CLASSIFY_RESPONSE_FORMAT

    try:
        LlamaGrammar.from_json_schema(json.dumps(_CLASSIFY_JSON_SCHEMA), verbose=False)
    except Exception:
        log.exception(
            "this llama-cpp-python build cannot convert the /classify JSON schema to a "
            "grammar — falling back to plain json_object. Empty '{}' completions become "
            "possible again and are handled by the retry/fallback path"
        )
        return {"type": "json_object"}

    log.info("/classify JSON schema verified: empty completions are ungrammatical")
    return _CLASSIFY_RESPONSE_FORMAT


def _install_shutdown_logging(startup_monotonic: float) -> None:
    """Wrap uvicorn's SIGTERM/SIGINT handlers so we get a log line with
    uptime and RSS when the process is asked to exit.

    Context: the service has been observed restarting every ~60-90 s with no
    error in the logs before the restart. That pattern is consistent with an
    external signal (compose stop / orchestrator / OOM of a sibling) or an
    OOM kill of this process itself. SIGKILL (OOM) is not catchable so it
    will still be silent — but if the cause is SIGTERM from the orchestrator,
    the line below pins it down the next time it happens.
    """

    def _make_handler(signum: int, previous: Any) -> Callable[[int, Any], None]:
        def _handler(sig: int, frame: Any) -> None:
            uptime = time.monotonic() - startup_monotonic
            try:
                name = signal.Signals(sig).name
            except ValueError:
                name = str(sig)
            log.warning(
                "Received %s after %.1fs uptime (RSS=%.0f MB) — shutting down",
                name, uptime, _rss_mb(),
            )
            if callable(previous):
                previous(sig, frame)
            elif previous in (signal.SIG_DFL, None):
                signal.signal(sig, signal.SIG_DFL)
                os.kill(os.getpid(), sig)
        return _handler

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            previous = signal.getsignal(sig)
            signal.signal(sig, _make_handler(sig, previous))
        except (ValueError, OSError):
            # Not on the main thread (e.g. under TestClient) — skip. Uvicorn's
            # own handlers are also main-thread-only, so parity is fine.
            pass


def _load_inproc_llm() -> None:
    """Load the GGUF into this process via llama-cpp-python (LLM_BACKEND=inproc)."""

    try:
        import llama_cpp
        from llama_cpp import Llama
    except ImportError as exc:
        raise RuntimeError(
            "LLM_BACKEND=inproc needs llama-cpp-python, which this image does not "
            "ship. The GPU image runs the model in a llama-server sidecar — set "
            "LLM_BACKEND=server (its default) or use the CPU image."
        ) from exc

    if LLM_ACCELERATOR == "cuda":
        supports_offload = getattr(llama_cpp, "llama_supports_gpu_offload", None)
        if not callable(supports_offload) or not supports_offload():
            raise RuntimeError(
                "LLM_ACCELERATOR=cuda was requested, but llama-cpp-python "
                "was built without CUDA offload support"
            )

    tuning = _optional_llama_kwargs(llama_cpp, Llama)
    log.info("Loading Llama from %s (ctx=%d, threads=%d, gpu_layers=%d, tuning=%s)",
             LLM_MODEL_PATH, LLM_CTX, LLM_THREADS, LLM_GPU_LAYERS, tuning or "{}")
    base_kwargs: dict[str, Any] = dict(
        model_path=str(LLM_MODEL_PATH),
        n_ctx=LLM_CTX,
        # 0 means "unset" in a stored configuration; the binding wants a real
        # number, so resolve it the way the environment default does.
        n_threads=LLM_THREADS or (os.cpu_count() or 4),
        n_gpu_layers=LLM_GPU_LAYERS,
        verbose=False,
    )
    try:
        _state["llm"] = Llama(**base_kwargs, **tuning)
    except Exception:
        # A rejected tuning value (unsupported KV type for the build, a
        # FlashAttention kernel the backend lacks, …) must degrade to the
        # previous behaviour rather than take the service down.
        if not tuning:
            raise
        log.exception("Llama load failed with tuning kwargs %s — retrying without them", tuning)
        _state["llm"] = Llama(**base_kwargs)
    log.info("Llama loaded (RSS=%.0f MB)", _rss_mb())


def _load_server_llm() -> None:
    """Bring up the llama-server backend and attach to it (LLM_BACKEND=server).

    This process owns the sidecar (see llama_supervisor) rather than inheriting
    one from entrypoint.sh, because switching models means stopping the old
    server and starting a new one with different arguments — something the app
    cannot do to a process it did not spawn.

    When the image ships no llama-server we only attach: pointing
    LLM_BACKEND=server at a server running elsewhere (another compose service,
    another host) is a legitimate setup, and the readiness wait against the URL
    is then the only check that makes sense.

    No fallback to the in-process backend either way: this backend exists
    precisely because the deployment needs a flag the binding cannot pass, and
    silently loading the same model the other way would either OOM the GPU or
    run at a fraction of the speed.
    """

    from llama_server import LlamaServerClient

    if _llama_server.available:
        if not _llama_server.is_running:
            _llama_server.start(_state["config"])
    else:
        log.warning(
            "LLM_BACKEND=server but %s is not present — expecting an external "
            "llama-server at %s",
            _llama_server.binary,
            LLM_SERVER_URL,
        )

    client = LlamaServerClient(LLM_SERVER_URL, request_timeout=float(LLM_SERVER_REQUEST_TIMEOUT))
    log.info(
        "Waiting for llama-server at %s (ctx=%d, gpu_layers=%d, n_cpu_moe=%d, timeout=%ds)",
        LLM_SERVER_URL, LLM_CTX, LLM_GPU_LAYERS, LLM_NCMOE, LLM_SERVER_READY_TIMEOUT,
    )
    # still_starting lets a crash during load (bad --n-cpu-moe, OOM, an
    # unsupported architecture) surface in seconds instead of only after the
    # full timeout — the difference between _reload_worker's except block
    # rolling back promptly and the caller sitting through the whole wait
    # first. Only meaningful when we spawned the process ourselves.
    props = client.wait_until_ready(
        float(LLM_SERVER_READY_TIMEOUT),
        still_starting=(lambda: _llama_server.is_running) if _llama_server.available else None,
    )
    _state["llm"] = client
    # n_ctx from /props is the server's actual window, which may differ from our
    # LLM_CTX if the sidecar clamped it — and LLM_CTX is what /classify budgets
    # its prompt against, so a mismatch is worth seeing in the log.
    server_ctx = props.get("default_generation_settings", {}).get("n_ctx") if isinstance(props, dict) else None
    if isinstance(server_ctx, int) and server_ctx < LLM_CTX:
        log.warning(
            "llama-server reports n_ctx=%d but LLM_CTX=%d: /classify will budget prompts "
            "against the larger value and the server will truncate. Align them.",
            server_ctx, LLM_CTX,
        )
    log.info("llama-server ready (model=%s)", props.get("model_path", "?") if isinstance(props, dict) else "?")


def _resolve_startup_config() -> tuple[LlmConfig, str]:
    """Pick the configuration to boot with: the activated one if there is one,
    the environment otherwise.

    A broken persisted file is *not* fatal. It would otherwise wedge the
    service into a crash loop that no endpoint could repair, since every
    endpoint lives behind this startup — so we log it and fall back to the
    environment, which is the configuration the deployment shipped with.
    """

    try:
        persisted = load_active(MODELS_DIR)
    except Exception:
        log.exception(
            "could not read the activated configuration from %s — falling back to "
            "the environment. Re-activate a configuration to replace the file.",
            MODELS_DIR,
        )
        return _BOOT_CONFIG, "env"

    if persisted is None:
        log.info("No activated configuration on the models volume — using the environment")
        return _BOOT_CONFIG, "env"

    log.info(
        "Using activated configuration %r (model=%s, backend=%s, ctx=%d)",
        persisted.label or "unnamed", persisted.model_path.name, persisted.backend, persisted.ctx,
    )
    return persisted, "file"


def _ensure_model_present(cfg: LlmConfig) -> None:
    """Make sure the GGUF for *cfg* is on the volume, downloading if it is not."""

    if cfg.model_path.exists():
        return

    if cfg.model_url:
        # An activated configuration carries its own URL, which is generally
        # *not* the one in LLM_MODEL_URL — so fetch it directly rather than
        # letting download_model.sh pull the environment's model.
        log.info("Model %s missing — downloading from %s", cfg.model_path.name, cfg.model_url)
        targets = [DownloadTarget(url=cfg.model_url, filename=cfg.model_path.name)]
        targets += [DownloadTarget(url=u, filename=filename_from_url(u)) for u in cfg.extra_urls]
        _downloads.run_blocking(targets, sha256=cfg.model_sha256)
        if not cfg.model_path.exists():
            raise RuntimeError(f"download finished but {cfg.model_path} is still missing")
        return

    log.info("LLM model not found at %s. Attempting to download...", cfg.model_path)
    import subprocess

    # Look for the download script in the standard container path,
    # or relative to main.py for local development.
    script_path = Path("/usr/local/bin/download_model.sh")
    if not script_path.exists():
        script_path = Path(__file__).parent / "download_model.sh"

    if not script_path.exists():
        raise RuntimeError(
            f"LLM model not found at {cfg.model_path} and download script not found at "
            f"{script_path}. Please ensure the models volume is correctly populated."
        )
    try:
        # We call the idempotent download script to populate both the GGUF
        # and the sentence-transformers cache before loading begins.
        subprocess.run([str(script_path)], check=True)
    except Exception as e:
        log.error("Auto-download failed: %s", e)
        raise RuntimeError(
            f"LLM model not found at {cfg.model_path} and auto-download failed. "
            "Run download_model.sh manually to investigate."
        ) from e


def _load_llm() -> None:
    """Load the model described by the live configuration."""

    if LLM_BACKEND == "server":
        _load_server_llm()
    else:
        _load_inproc_llm()
    _state["llm_accelerator"] = LLM_ACCELERATOR
    _state["classify_response_format"] = _resolve_classify_response_format()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    startup_monotonic = time.monotonic()

    cfg, source = _resolve_startup_config()
    _apply_config(cfg, source=source)
    _ensure_model_present(cfg)

    # Lazy imports keep `python main.py --help`-style inspection cheap and
    # move the heavy native-library load into startup, after logging is set up.
    import torch
    from sentence_transformers import SentenceTransformer

    _load_llm()

    embed_device = _resolve_embed_device(torch)
    log.info("Loading embedder %s on %s", EMBEDDING_MODEL, embed_device)
    _state["embedder"] = SentenceTransformer(EMBEDDING_MODEL, device=embed_device)
    _state["embedder_device"] = embed_device
    if torch.cuda.is_available():
        _state["cuda_device_name"] = torch.cuda.get_device_name(0)
    log.info("Embedder loaded (RSS=%.0f MB)", _rss_mb())

    _install_shutdown_logging(startup_monotonic)
    _state["startup_monotonic"] = startup_monotonic

    log.info("Ready.")
    yield
    # The mmaps go with the process, but the llama-server subprocess does not:
    # left behind it would keep the GPU allocated and the port bound, so a
    # container restart would find its own successor in the way.
    _downloads.cancel()
    _llama_server.stop()


app = FastAPI(title="llm-service", version="1.0.0", lifespan=lifespan)


# ─── Blocking-call offload ─────────────────────────────────────────────────────
#
# llama-cpp-python's ``create_chat_completion`` and sentence-transformers'
# ``encode`` are synchronous and CPU-bound; calling them from the async
# handlers directly blocks the FastAPI event loop for the full inference
# duration (easily 10–60 s on a CPU-only box). While the loop is blocked,
# ``/healthz`` cannot respond, so the compose healthcheck (``curl /healthz``,
# 10 s timeout) fails, the container flips to "unhealthy" under load, and a
# concurrent ``docker compose up -d`` bails out with "dependency failed to
# start: service llm_service is unhealthy" for anything that depends on it.
#
# A single-worker executor preserves the required serialisation — a single
# ``Llama`` instance is not thread-safe, and running llama + embedder
# concurrently on one CPU only causes contention — while keeping the event
# loop free to serve the healthcheck.
_inference_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="llm-inference")
# Semaphore mirrors max_workers=1.  Callers wait up to acquire_timeout seconds
# before receiving a 503, so short operations (embed ~1 s) don't spuriously
# block a concurrent classify.  Initialised lazily on first use so it binds
# to the correct event loop.
_inference_sem: asyncio.Semaphore | None = None


def _get_inference_sem() -> asyncio.Semaphore:
    global _inference_sem
    if _inference_sem is None:
        _inference_sem = asyncio.Semaphore(1)
    return _inference_sem

_T = TypeVar("_T")


async def _run_blocking(
    func: Callable[..., _T],
    *args: Any,
    acquire_timeout: float = 10.0,
    **kwargs: Any,
) -> _T:
    """Run *func* in the shared single-worker executor.

    Waits up to *acquire_timeout* seconds for the inference semaphore.  This
    lets short operations (e.g. a ~1 s embed) finish without immediately
    returning 503 to a caller that arrived a moment too late.  Callers that
    genuinely hit a busy LLM (10–60 s inference) still get a fast 503 once
    the timeout elapses.
    """
    sem = _get_inference_sem()
    try:
        await asyncio.wait_for(sem.acquire(), timeout=acquire_timeout)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="inference busy")
    try:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            _inference_executor, functools.partial(func, *args, **kwargs)
        )
    finally:
        sem.release()


# ─── UTF-8 repair ──────────────────────────────────────────────────────────────
#
# llama-cpp-python's JSON-grammar-constrained generation works at the byte
# level and occasionally emits a multi-byte UTF-8 codepoint split across two
# grammar "tokens", so ``detokenize().decode("utf-8", errors="replace")``
# inside the library can produce Latin-1 / Windows-1252 interpretations of
# the raw bytes. The classic symptom is "Brüssel" coming back as "BrÃ¼ssel"
# (the UTF-8 bytes ``C3 BC`` read as two separate Latin-1 characters).
#
# We fix this at the source — right after JSON parsing on the producer side
# — by attempting a Latin-1 → UTF-8 round-trip and keeping the repaired form
# only when it looks meaningfully different and remains valid UTF-8. The
# function is a no-op on already-clean text, so it's safe to apply
# universally to every string field we return.

_MOJIBAKE_PATTERN = re.compile(r"[ÂÃ][-¿]")


def _repair_mojibake(value: str | None) -> str | None:
    if value is None or value == "":
        return value
    if not _MOJIBAKE_PATTERN.search(value):
        return value
    try:
        repaired = value.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value
    if "�" in repaired:
        return value
    return repaired


def _repair_fields(data: dict[str, Any], keys: tuple[str, ...]) -> None:
    """In-place ``_repair_mojibake`` for the given string keys of ``data``."""

    for key in keys:
        v = data.get(key)
        if isinstance(v, str):
            data[key] = _repair_mojibake(v)


def _repair_tags(data: dict[str, Any]) -> None:
    tags = data.get("tags")
    if isinstance(tags, list):
        data["tags"] = [_repair_mojibake(t) if isinstance(t, str) else t for t in tags]


def _sane_tax_year(value: Any) -> int | None:
    """Coerce the model's ``tax_year`` to a plausible year, or None.

    A four-digit number on a scan is not necessarily a tax year, and a small
    classifier reliably grabs the wrong one: the observed production case was a
    doctor's invoice dated 12.03.2019 whose patient birth year (1955) came back
    as the tax year. Non-numeric, out-of-range and nonsensical values all
    collapse to None here.
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        year = int(value)
    except (TypeError, ValueError):
        return None
    return year if TAX_YEAR_MIN <= year <= TAX_YEAR_MAX else None


# Fields ClassifyResponse requires with no default — a completion missing
# ALL of these is a degenerate/near-empty generation (observed: an LLM
# response containing only tax/document-type keys, which the /classify
# handler always injects regardless of what the model returned), not a
# genuine classification attempt that merely got one value wrong.
_CLASSIFY_CORE_FIELDS = ("category_slug", "title", "summary", "tags", "confidence")


def _has_core_fields(data: dict[str, Any]) -> bool:
    return any(data.get(k) is not None for k in _CLASSIFY_CORE_FIELDS)


# The app's catch-all category slug (see documents/taxonomy.ts). When the model
# reproducibly returns degenerate output even after a varied retry, the service
# falls back to this so the document lands as a low-confidence "sonstiges"
# document — usable, in the review queue, and still open to the app's
# deterministic sender/content rules — rather than dead-ending on a hard error.
_FALLBACK_CATEGORY_SLUG = "sonstiges"


def _degenerate_fallback(req: "ClassifyRequest", reason: str) -> ClassifyResponse:
    """Last-resort minimal classification for a persistently degenerate model
    output. Uses the offered ``sonstiges`` node with confidence 0.0 (empty
    title/summary/tags — the app fills the title from the filename). Raises a
    hard 422 (never 502, which the caller would treat as a transient outage and
    defer for an unbounded retry) when no fallback category was offered."""

    node = next((n for n in req.taxonomy if n.slug == _FALLBACK_CATEGORY_SLUG), None)
    if node is None:
        raise HTTPException(
            status_code=422,
            detail=(
                f"classify failed: {reason}, and no "
                f"'{_FALLBACK_CATEGORY_SLUG}' fallback category was offered"
            ),
        )
    log.warning(
        "classify: %s after retries — falling back to '%s' (confidence 0)",
        reason, node.slug,
    )
    return ClassifyResponse(
        category_slug=node.slug, title="", summary="", tags=[], confidence=0.0
    )


# ─── /healthz ──────────────────────────────────────────────────────────────────


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    started = _state.get("startup_monotonic")
    uptime_s = (time.monotonic() - started) if isinstance(started, float) else None
    return {
        "status": "ok" if _state["llm"] and _state["embedder"] else "starting",
        "llm_loaded": _state["llm"] is not None,
        "embedder_loaded": _state["embedder"] is not None,
        "prompts_configured": _CLASSIFY_PROMPTS is not None,
        "llm_model_path": str(LLM_MODEL_PATH),
        "llm_accelerator": _state["llm_accelerator"] or LLM_ACCELERATOR,
        "llm_gpu_layers": LLM_GPU_LAYERS,
        "llm_backend": LLM_BACKEND,
        # Expert-offload split, server backend only: the number of leading
        # layers whose MoE experts live in system RAM. 0 on a dense model.
        "llm_n_cpu_moe": LLM_NCMOE if LLM_BACKEND == "server" else None,
        "llm_ctx": LLM_CTX,
        # The vision tower, or None for a text-only service. Without it
        # /vision/transcribe answers 503 while everything else works normally,
        # which is otherwise a puzzling state to diagnose.
        "llm_mmproj_path": _state["config"].mmproj_path or None,
        # Which named configuration is loaded, and whether it came from an
        # activated row or from the environment. "env" is the state of any
        # deployment that has never used the admin UI.
        "llm_config_label": _state["config"].label or None,
        "llm_config_id": _state["config"].config_id,
        "llm_config_source": _state["config_source"],
        "llm_reload_state": _reload_status["state"],
        "embedding_model": EMBEDDING_MODEL,
        "embedder_device": _state["embedder_device"] or LLM_EMBED_DEVICE,
        "embed_batch_size": LLM_EMBED_BATCH_SIZE,
        "cuda_device_name": _state["cuda_device_name"],
        "rss_mb": round(_rss_mb(), 1),
        "uptime_s": round(uptime_s, 1) if uptime_s is not None else None,
    }


# ─── Runtime model configuration ──────────────────────────────────────────────
#
# A model swap is a multi-minute operation — stop the server, possibly fetch
# 26 GB of weights, load them — so /reload accepts the request, answers 202 and
# does the work in the background. Callers poll /reload/status.
#
# Inference is unavailable meanwhile: _state["llm"] is cleared first, which the
# existing guards in /classify, /embed and /json-prompt already turn into a 503,
# and the app's llm-client already treats a 503 as "defer and retry later".

# How long a reload waits for an in-flight inference to finish before giving
# up. Generous on purpose: a classify against a MoE model split across system
# RAM can legitimately run for minutes, and cutting it off to swap the model
# wastes the work rather than saving time.
RELOAD_DRAIN_TIMEOUT = 900.0

# Reloads run on their own thread, not on the inference executor and not as an
# asyncio task. Not the inference executor because a multi-minute model load
# would queue every /embed behind it, and the embedder is not part of the swap.
# Not an asyncio task because it must outlive the request that started it, and
# a task holds no claim on the loop once the response has been sent.
_reload_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="llm-reload")

_RELOAD_STATES = ("idle", "stopping", "downloading", "loading", "ready", "error")

_reload_status: dict[str, Any] = {
    "state": "idle",
    "detail": None,
    "label": "",
    "started_at": None,
    "finished_at": None,
}
# Rejects a second concurrent reload. Not a queue: two operators racing to
# activate different models is a mistake to surface, not one to serialise.
_reload_running = False


def _set_reload_state(state: str, *, detail: str | None = None) -> None:
    _reload_status["state"] = state
    _reload_status["detail"] = detail
    if state in {"ready", "error"}:
        _reload_status["finished_at"] = time.time()


def _config_view() -> dict[str, Any]:
    cfg: LlmConfig = _state["config"]
    data = cfg.to_dict()
    data["source"] = _state["config_source"]
    data["model_present"] = cfg.model_path.exists()
    return data


def _drain_inference() -> None:
    """Block until nothing is running on the inference executor.

    It has a single worker, so a no-op job returns only once whatever was in
    front of it has finished. Cheaper than cancelling an in-flight classify,
    and it means a swap never pulls the model out from under a request that
    has already paid for most of its prefill.
    """

    _inference_executor.submit(lambda: None).result(timeout=RELOAD_DRAIN_TIMEOUT)


def _reload_worker(cfg: LlmConfig) -> None:
    """Swap the loaded model. Runs on the reload thread."""

    previous: LlmConfig = _state["config"]

    # Reject new work first, then wait for the work already accepted.
    _state["llm"] = None
    _drain_inference()

    if _llama_server.is_running:
        _set_reload_state("stopping")
        _llama_server.stop()

    try:
        if not cfg.model_path.exists():
            _set_reload_state("downloading")
        _ensure_model_present(cfg)

        _set_reload_state("loading")
        _apply_config(cfg, source="file")
        _load_llm()
    except Exception:
        # Try to get back to the model that was working. If that fails too the
        # service stays down and the compose healthcheck restarts it, which is
        # the right outcome — but the common case (a typo'd filename, a model
        # this llama.cpp build cannot read) recovers without an outage.
        log.exception("Reload failed — restoring the previous configuration")
        try:
            if _llama_server.is_running:
                _llama_server.stop()
            _apply_config(previous, source=_state["config_source"])
            _load_llm()
            log.info("Previous configuration restored")
        except Exception:
            log.exception("Could not restore the previous configuration either")
        raise

    # Persisted only now: a configuration that cannot load must not become the
    # one the container boots into after a restart.
    save_active(MODELS_DIR, cfg)
    log.info("Reload complete: %s (%s)", cfg.model_path.name, cfg.label or "unnamed")


def _submit_reload(worker: Callable[[], None], *, label: str) -> None:
    """Hand *worker* to the reload thread and report its outcome through
    /reload/status."""

    global _reload_running

    _reload_running = True
    _reload_status.update(
        {"label": label, "started_at": time.time(), "finished_at": None, "detail": None}
    )
    _set_reload_state("stopping")

    def done(fut: "Future[None]") -> None:
        global _reload_running
        try:
            fut.result()
            _set_reload_state("ready")
        except Exception as exc:  # noqa: BLE001 — reported through /reload/status
            _set_reload_state("error", detail=f"{type(exc).__name__}: {exc}")
        finally:
            _reload_running = False

    _reload_executor.submit(worker).add_done_callback(done)


class ReloadRequest(BaseModel):
    """One row of the app's llm_model_config table, as JSON.

    Field names match the table's columns rather than this module's globals so
    the app can hand a row over without a translation layer; LlmConfig.from_dict
    owns the mapping and the validation.
    """

    # extra=allow: the app sends the whole row and LlmConfig.from_dict picks
    # what it understands, so adding a column does not need a change here.
    # protected_namespaces=(): pydantic reserves the "model_" prefix by
    # default, and these field names come from the database schema.
    model_config = {"extra": "allow", "protected_namespaces": ()}

    model_filename: str = Field(..., min_length=1)


@app.get("/config")
async def get_config() -> dict[str, Any]:
    return {"config": _config_view(), "reload": dict(_reload_status)}


@app.post("/reload", status_code=202)
async def reload_model(req: ReloadRequest) -> dict[str, Any]:
    if _reload_running:
        raise HTTPException(status_code=409, detail="a reload is already running")
    if _downloads.busy:
        raise HTTPException(
            status_code=409,
            detail="a model download is running — wait for it or cancel it first",
        )

    payload = req.model_dump()
    # The sidecar address is a property of this container, not of the stored
    # configuration — the app has no business knowing the loopback port, and a
    # row that omitted it would otherwise silently fall back to the dataclass
    # default rather than to what LLM_SERVER_URL says.
    if not payload.get("server_url"):
        payload["server_url"] = _BOOT_CONFIG.server_url

    try:
        cfg = LlmConfig.from_dict(payload, models_dir=MODELS_DIR)
    except ConfigError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if cfg.backend == "server" and not _llama_server.available:
        # Loading it in-process instead would silently ignore the very flags
        # this backend was chosen for, so refuse rather than degrade.
        raise HTTPException(
            status_code=422,
            detail=(
                f"backend 'server' needs a llama-server binary; {_llama_server.binary} "
                "is not present in this image (the GPU image ships it)"
            ),
        )
    if not cfg.model_path.exists() and not cfg.model_url:
        raise HTTPException(
            status_code=422,
            detail=f"{cfg.model_path.name} is not on the models volume and no model_url was given",
        )

    _submit_reload(functools.partial(_reload_worker, cfg), label=cfg.label)
    return {"status": "accepted", "reload": dict(_reload_status)}


@app.get("/reload/status")
async def reload_status() -> dict[str, Any]:
    return {
        "reload": dict(_reload_status),
        "llm_loaded": _state["llm"] is not None,
        "config": _config_view(),
        "download": _downloads.status(),
    }


@app.post("/config/reset", status_code=202)
async def reset_config() -> dict[str, Any]:
    """Discard the activated configuration and go back to the environment.

    The way out if an activated configuration turns out to be wrong: it
    restores exactly what compose/.env describe, which is the state a
    deployment that never used the UI is in.
    """

    if _reload_running:
        raise HTTPException(status_code=409, detail="a reload is already running")

    removed = clear_active(MODELS_DIR)
    _submit_reload(_reload_worker_env, label="")
    return {"status": "accepted", "removed_file": removed, "reload": dict(_reload_status)}


def _reload_worker_env() -> None:
    """Same as :func:`_reload_worker` for the environment config, minus the
    persistence step — the whole point is that no file remains."""

    _state["llm"] = None
    _drain_inference()
    if _llama_server.is_running:
        _llama_server.stop()
    _ensure_model_present(_BOOT_CONFIG)
    _set_reload_state("loading")
    _apply_config(_BOOT_CONFIG, source="env")
    _load_llm()
    log.info("Back on the environment configuration (%s)", _BOOT_CONFIG.model_path.name)


# ─── Model files on the volume ────────────────────────────────────────────────


class DownloadRequest(BaseModel):
    url: str = Field(..., min_length=1)
    # Defaults to the URL's basename, which is what an operator pasting a
    # Hugging Face link almost always wants.
    filename: str | None = None
    sha256: str | None = None
    # Further shards of a split GGUF; each lands under its own basename.
    extra_urls: list[str] = Field(default_factory=list)


@app.get("/models/files")
async def models_files() -> dict[str, Any]:
    return {
        "models_dir": str(MODELS_DIR),
        "files": list_model_files(MODELS_DIR),
        "active_filename": LLM_MODEL_PATH.name,
        "disk": disk_usage(MODELS_DIR),
        "download": _downloads.status(),
    }


@app.post("/models/download", status_code=202)
async def models_download(req: DownloadRequest) -> dict[str, Any]:
    try:
        targets = [
            DownloadTarget(url=req.url, filename=req.filename or filename_from_url(req.url))
        ]
        targets += [DownloadTarget(url=u, filename=filename_from_url(u)) for u in req.extra_urls]
        _downloads.start(targets, sha256=req.sha256 or "")
    except DownloadError as exc:
        # "already running" is a conflict, everything else is bad input.
        status = 409 if "already running" in str(exc) else 422
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    return {"status": "accepted", "download": _downloads.status()}


@app.get("/models/download/status")
async def models_download_status() -> dict[str, Any]:
    return {"download": _downloads.status()}


@app.post("/models/download/cancel")
async def models_download_cancel() -> dict[str, Any]:
    cancelled = _downloads.cancel()
    return {"cancelled": cancelled, "download": _downloads.status()}


@app.delete("/models/files/{filename}")
async def models_delete(filename: str) -> dict[str, Any]:
    if filename == LLM_MODEL_PATH.name:
        raise HTTPException(status_code=409, detail="cannot delete the model currently loaded")
    if _downloads.busy and _downloads.status().get("filename") == filename:
        raise HTTPException(status_code=409, detail="that file is being downloaded right now")
    try:
        delete_model_file(MODELS_DIR, filename)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except DownloadError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"status": "deleted", "filename": filename, "disk": disk_usage(MODELS_DIR)}


# ─── PUT /prompts ─────────────────────────────────────────────────────────────


class PromptsConfig(BaseModel):
    """Classify prompt parts pushed lazily from the Encore app."""

    classify_system: str = Field(..., min_length=1)
    classify_document_type: str = Field(..., min_length=1)
    classify_tax: str = Field(..., min_length=1)
    classify_subject_persons: str = Field(..., min_length=1)
    classify_examples: str = Field(..., min_length=1)


@app.put("/prompts")
async def configure_prompts(config: PromptsConfig) -> dict[str, Any]:
    global _CLASSIFY_PROMPTS
    _CLASSIFY_PROMPTS = {
        "system": config.classify_system,
        "document_type": config.classify_document_type,
        "tax": config.classify_tax,
        "subject_persons": config.classify_subject_persons,
        "examples": config.classify_examples,
    }
    total = sum(len(v) for v in _CLASSIFY_PROMPTS.values())
    log.info("Prompts configured (%d chars total)", total)
    return {"status": "ok", "total_chars": total}


# ─── /embed ────────────────────────────────────────────────────────────────────


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1)
    # e5-family models (``intfloat/multilingual-e5-*``, ``intfloat/e5-*``)
    # are trained with explicit ``query: `` / ``passage: `` prefixes; without
    # them retrieval quality drops by several nDCG points because query and
    # passage vectors live in subtly misaligned subspaces. Callers therefore
    # tell us what they're embedding so the service can apply the right
    # prefix. Default ``passage`` matches the corpus-side use which is the
    # more common path (every document chunk goes through here).
    kind: str = Field(default="passage", pattern="^(passage|query)$")


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    dim: int


def _is_e5_model(name: str) -> bool:
    """E5 family detection by repo name. Covers ``intfloat/e5-*`` and
    ``intfloat/multilingual-e5-*`` variants."""

    n = name.lower()
    return n.startswith("intfloat/e5-") or n.startswith("intfloat/multilingual-e5-")


def _apply_embedding_prefix(texts: list[str], kind: str) -> list[str]:
    """Prepend the model-appropriate prefix. No-op for non-e5 models."""

    if not _is_e5_model(EMBEDDING_MODEL):
        return texts
    prefix = "query: " if kind == "query" else "passage: "
    return [prefix + t for t in texts]


@app.post("/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest) -> EmbedResponse:
    embedder = _state["embedder"]
    if embedder is None:
        raise HTTPException(status_code=503, detail="embedder not loaded")
    prepared = _apply_embedding_prefix(req.texts, req.kind)
    vectors = await _run_blocking(
        lambda: embedder.encode(
            prepared, normalize_embeddings=True, batch_size=LLM_EMBED_BATCH_SIZE
        ).tolist()
    )
    return EmbedResponse(embeddings=vectors, dim=len(vectors[0]) if vectors else 0)


# ─── /classify ─────────────────────────────────────────────────────────────────


class TaxonomyNode(BaseModel):
    slug: str
    name: str
    parent_slug: str | None = None
    # Optional disambiguation hint, rendered as "slug: Name — Hinweis".
    hint: str | None = None


class TaxSectionEntry(BaseModel):
    """One German income-tax section (Anlage / Abzugsbereich) sent to the
    classifier so it can pick from a fixed label set, identical in spirit to
    :class:`TaxonomyNode` but flat (no parent) and with an extra human hint.
    """

    slug: str
    name: str
    group: str  # "einkuenfte" | "abzuege" | "bescheid" | "rahmen"
    hint: str | None = None


class DocumentTypeEntry(BaseModel):
    """One document *type* (Dokumentart) offered to the classifier as a fixed
    label set, so it can pick the single best-matching kind of paperwork
    (Rechnung, Bescheid, Vertrag …) orthogonally to the category. Flat, with a
    human hint like :class:`TaxSectionEntry`."""

    slug: str
    name: str
    hint: str | None = None


class SubjectPersonEntry(BaseModel):
    """Per-user mapping of a literal name as it appears on documents to
    the user's relationship tag (e.g. "Erika Mustermann" → "mutter").
    When the OCR text mentions ``full_name`` the classifier is asked
    to append ``relation_tag`` to its ``tags`` output.

    ``relation_kind``, ``tax_cost_bearer`` and ``in_household`` come from the
    household model and drive the tax decision: they tell an unambiguous
    deduction of the user's (spouse under Zusammenveranlagung, own child in
    the household) from a genuinely open case (parent, ward). Optional —
    older callers that only send name + tag keep working."""

    full_name: str
    relation_tag: str
    relation_kind: str = ""
    tax_cost_bearer: str = ""
    in_household: bool | None = None


class ExampleEntry(BaseModel):
    """One already-classified, content-similar document of the same household,
    retrieved by embedding similarity and rendered into the prompt as a
    few-shot anchor. Orientation only — the classifier still decides from the
    document text. Empty list = few-shot disabled; prompt section is omitted."""

    category_slug: str
    category_name: str = ""
    title: str = ""
    sender: str | None = None


class ClassifyRequest(BaseModel):
    text: str = Field(..., min_length=1)
    taxonomy: list[TaxonomyNode] = Field(..., min_length=1)
    # Optional: if non-empty the classifier picks the single best-matching
    # document type (Dokumentart) from this fixed set. Empty list = disabled.
    document_types: list[DocumentTypeEntry] = Field(default_factory=list)
    # Optional: if non-empty the classifier is asked to additionally decide
    # whether the document is relevant for the German income-tax return and
    # which section(s) it belongs to. Empty list = tax detection disabled.
    tax_sections: list[TaxSectionEntry] = Field(default_factory=list)
    # Per-user "Bezugspersonen" — populates `subject_persons` block in
    # the prompt so address/recipient matches auto-tag the document.
    # Empty list = no Bezugsperson hints; prompt section is omitted.
    subject_persons: list[SubjectPersonEntry] = Field(default_factory=list)
    # Joint vs. separate assessment ("zusammen" | "einzeln" | "unknown").
    # Decides whether a spouse's deduction belongs on the user's return —
    # rendered next to the Bezugspersonen list when tax detection is on.
    # Empty string = unknown; the line is omitted.
    assessment_type: str = ""
    # Nearest already-classified documents (retrieval-augmented few-shot).
    # Empty list = no examples; prompt section is omitted.
    examples: list[ExampleEntry] = Field(default_factory=list)
    # Optional hints: sender hint from OCR, upload filename, user locale.
    locale: str = "de"
    max_tags: int = 6


class TaxAssignment(BaseModel):
    """One (slug, confidence) tuple returned by the classifier for a
    tax-return section it thinks the document belongs to."""

    slug: str
    confidence: float = Field(..., ge=0.0, le=1.0)


class ClassifyResponse(BaseModel):
    category_slug: str
    title: str
    doc_date: str | None = None
    sender: str | None = None
    document_number: str | None = None
    summary: str
    tags: list[str]
    confidence: float = Field(..., ge=0.0, le=1.0)
    # Document-type facet — default null so callers that don't send
    # ``document_types`` still get a valid response.
    document_type: str | None = None
    document_type_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    # Tax-return fields — default "not relevant" so existing callers that
    # don't send ``tax_sections`` still get a valid response.
    tax_relevant: bool = False
    # Lower bound 1970 (not e.g. 2000): household documents legitimately span
    # decades — a 1997 Jahresdepotauszug is a real, unremarkable case, and
    # rejecting it here previously misrouted the document into the "LLM
    # service unavailable" retry path (see the classify handler below), which
    # defers forever instead of surfacing the failure. Values outside the range
    # never reach this bound: the handler nulls them first (``_sane_tax_year``),
    # so the constraint documents the contract rather than enforcing it.
    tax_year: int | None = Field(default=None, ge=TAX_YEAR_MIN, le=TAX_YEAR_MAX)
    tax_year_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    tax_sections: list[TaxAssignment] = Field(default_factory=list)


# Output grammar for /classify.
#
# ``response_format={"type": "json_object"}`` alone constrains the completion to
# *some* valid JSON object — and ``{}`` is the shortest string that satisfies
# that. It is therefore the cheapest escape for a model that would rather be
# emitting something the grammar forbids (Qwen3 opening a ``<think>`` block, for
# one). Measured on a 7697-document run: ~200 first attempts returned ``{}``, and
# 66 of those still did on the retry and dead-ended in the sonstiges fallback
# with confidence 0 — documents that look like ordinary low-confidence results
# but never got classified at all.
#
# Passing a schema makes llama.cpp derive a GBNF grammar from it, so the five
# fields ClassifyResponse has no default for cannot be omitted. ``{}`` stops
# being a reachable output rather than being retried after the fact.
#
# Every OPTIONAL field is listed here too, even though none of them is required:
# llama.cpp builds the object rule from ``properties``, so a field left out
# would become unemittable and the document-type and tax facets would silently
# stop working. ``required`` is what does the actual constraining. Value ranges
# (confidence 0..1, tax_year 1970..2100) are deliberately not expressed — the
# grammar cannot enforce them meaningfully, and the pydantic validation below
# already rejects out-of-range values as a schema mismatch.
_CLASSIFY_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "category_slug": {"type": "string"},
        "title": {"type": "string"},
        "doc_date": {"type": ["string", "null"]},
        "sender": {"type": ["string", "null"]},
        "document_number": {"type": ["string", "null"]},
        "summary": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "number"},
        "document_type": {"type": ["string", "null"]},
        "document_type_confidence": {"type": "number"},
        "tax_relevant": {"type": "boolean"},
        "tax_year": {"type": ["integer", "null"]},
        "tax_year_confidence": {"type": "number"},
        "tax_sections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "slug": {"type": "string"},
                    "confidence": {"type": "number"},
                },
                "required": ["slug", "confidence"],
            },
        },
    },
    "required": list(_CLASSIFY_CORE_FIELDS),
}

_CLASSIFY_RESPONSE_FORMAT: dict[str, Any] = {
    "type": "json_object",
    "schema": _CLASSIFY_JSON_SCHEMA,
}


_CLASSIFY_PROMPTS: dict[str, str] | None = None


def _taxonomy_outline(nodes: list[TaxonomyNode], *, with_hints: bool = True) -> str:
    by_parent: dict[str | None, list[TaxonomyNode]] = {}
    for n in nodes:
        by_parent.setdefault(n.parent_slug, []).append(n)

    def render(parent: str | None, depth: int) -> list[str]:
        lines: list[str] = []
        for n in by_parent.get(parent, []):
            indent = "  " * depth
            hint = f" — {n.hint}" if with_hints and n.hint else ""
            lines.append(f"{indent}- {n.slug}: {n.name}{hint}")
            lines.extend(render(n.slug, depth + 1))
        return lines

    return "\n".join(render(None, 0))


_TAX_GROUP_LABELS: dict[str, str] = {
    "einkuenfte": "Einkünfte",
    "abzuege": "Abzüge",
    "bescheid": "Bescheide",
    "rahmen": "Rahmen / Stammdaten",
}
_TAX_GROUP_ORDER: tuple[str, ...] = ("einkuenfte", "abzuege", "bescheid", "rahmen")


def _subject_persons_outline(entries: list[SubjectPersonEntry]) -> str:
    """Render the Bezugspersonen list. Empty input yields '' so the
    caller can omit the prompt section entirely.

    Household attributes are appended only when the caller supplied them, so
    a list without them renders exactly as before."""
    if not entries:
        return ""
    lines: list[str] = []
    for e in entries:
        line = f"- {e.full_name} → {e.relation_tag}"
        attrs: list[str] = []
        if e.relation_kind:
            attrs.append(f"relation_kind={e.relation_kind}")
        if e.tax_cost_bearer:
            attrs.append(f"tax_cost_bearer={e.tax_cost_bearer}")
        if e.in_household is not None:
            attrs.append(f"in_household={'ja' if e.in_household else 'nein'}")
        if attrs:
            line += f" ({', '.join(attrs)})"
        lines.append(line)
    return "\n".join(lines)


def _examples_outline(entries: list[ExampleEntry]) -> str:
    """Render the few-shot examples as 'Absender X | Titel Y → slug (Name)'.
    Empty input yields '' so the caller can omit the prompt section."""
    if not entries:
        return ""
    lines: list[str] = []
    for e in entries:
        sender = e.sender if e.sender else "unbekannt"
        cat = f"{e.category_slug} ({e.category_name})" if e.category_name else e.category_slug
        lines.append(f"- Absender: {sender} | Titel: {e.title} → {cat}")
    return "\n".join(lines)


def _document_types_outline(entries: list[DocumentTypeEntry], *, with_hints: bool = True) -> str:
    """Render the document-type list as "- slug: Name — Hinweis" lines.
    Empty input yields an empty string (caller must gate on that)."""

    if not entries:
        return ""
    lines: list[str] = []
    for e in entries:
        hint = f" — {e.hint}" if with_hints and e.hint else ""
        lines.append(f"- {e.slug}: {e.name}{hint}")
    return "\n".join(lines)


def _tax_sections_outline(entries: list[TaxSectionEntry], *, with_hints: bool = True) -> str:
    """Render the tax-section list grouped by ``group`` in a stable order.
    Empty input yields an empty string (caller must gate on that)."""

    if not entries:
        return ""

    by_group: dict[str, list[TaxSectionEntry]] = {}
    for e in entries:
        by_group.setdefault(e.group, []).append(e)

    lines: list[str] = []
    seen: set[str] = set()
    for group in _TAX_GROUP_ORDER:
        if group not in by_group:
            continue
        seen.add(group)
        lines.append(f"[{_TAX_GROUP_LABELS[group]}]")
        for e in by_group[group]:
            hint = f" — {e.hint}" if with_hints and e.hint else ""
            lines.append(f"- {e.slug}: {e.name}{hint}")
    for group, items in by_group.items():
        if group in seen:
            continue
        lines.append(f"[{group}]")
        for e in items:
            hint = f" — {e.hint}" if with_hints and e.hint else ""
            lines.append(f"- {e.slug}: {e.name}{hint}")
    return "\n".join(lines)


_CLASSIFY_MAX_TOKENS = 768
# Headroom for chat-template overhead (role markers, BOS/EOS, separators) that
# our raw-string token count does not see. 256 is generous for a Llama-style
# template; the alternative is to recreate the template here, which couples us
# to the model.
_CLASSIFY_TEMPLATE_HEADROOM = 256


def _count_tokens(llm: Any, text: str) -> int | None:
    """Count tokens for *text* using the loaded Llama. Returns ``None`` when
    the bound object does not expose ``tokenize`` (e.g. test stubs); callers
    fall back to the static char-cap in that case."""

    tokenize = getattr(llm, "tokenize", None)
    if not callable(tokenize):
        return None
    try:
        return len(tokenize(text.encode("utf-8"), add_bos=False, special=False))
    except Exception:
        return None


def _truncate_to_tokens(llm: Any, text: str, max_tokens: int) -> str | None:
    """Token-accurate truncation; returns ``None`` if the Llama does not
    expose ``tokenize``/``detokenize``."""

    tokenize = getattr(llm, "tokenize", None)
    detokenize = getattr(llm, "detokenize", None)
    if not callable(tokenize) or not callable(detokenize):
        return None
    try:
        tokens = tokenize(text.encode("utf-8"), add_bos=False, special=False)
        if len(tokens) <= max_tokens:
            return text
        truncated = detokenize(tokens[:max_tokens])
        if isinstance(truncated, bytes):
            return truncated.decode("utf-8", errors="ignore")
        return str(truncated)
    except Exception:
        return None


@app.post("/classify", response_model=ClassifyResponse)
async def classify(req: ClassifyRequest) -> ClassifyResponse:
    llm = _state["llm"]
    if llm is None:
        raise HTTPException(status_code=503, detail="llm not loaded")

    prompts = _CLASSIFY_PROMPTS
    if prompts is None:
        raise HTTPException(
            status_code=412,
            detail="prompts_not_configured",
        )

    # Initial char-cap remains as a cheap upper bound. A token-budget pass
    # below shrinks `text` further when the taxonomy + tax_sections outline
    # bloat the prompt past n_ctx (issue #325).
    text = req.text[:CLASSIFY_TEXT_CHAR_LIMIT]

    doctype_active = bool(req.document_types)
    tax_active = bool(req.tax_sections)
    subjects_active = bool(req.subject_persons)
    examples_active = bool(req.examples)
    hints_active = True

    subjects_block = (
        f"\n\nBezugspersonen (Name → Beziehungs-Tag):\n{_subject_persons_outline(req.subject_persons)}"
        if subjects_active
        else ""
    )
    # The assessment type only matters for the tax decision (spouse under
    # Zusammenveranlagung), so it rides along with the tax facet.
    if tax_active and req.assessment_type:
        subjects_block += f"\n\nVeranlagungsart: {req.assessment_type}"

    def _build_data_blocks(*, with_hints: bool) -> tuple[str, str, str]:
        h_label = " — Hinweis" if with_hints else ""
        dt = (
            f"\n\nDokumentarten (slug: Name{h_label}):\n"
            f"{_document_types_outline(req.document_types, with_hints=with_hints)}"
            if doctype_active
            else ""
        )
        tx = (
            f"\n\nSteuer-Sektionen (slug: Name{h_label}):\n"
            f"{_tax_sections_outline(req.tax_sections, with_hints=with_hints)}"
            if tax_active
            else ""
        )
        tax_outline = _taxonomy_outline(req.taxonomy, with_hints=with_hints)
        return tax_outline, dt, tx

    # The few-shot examples are orientation only and must never be the reason a
    # classification fails: when the prompt overflows the context window they
    # are shed first (below), so the document still gets classified zero-shot.
    # Hints are shed second — without them the model still sees slug + name.
    def _assemble(with_examples: bool, with_hints: bool) -> tuple[str, Callable[[str], str]]:
        system_prompt = (
            prompts["system"]
            + (prompts["document_type"] if doctype_active else "")
            + (prompts["tax"] if tax_active else "")
            + (prompts["subject_persons"] if subjects_active else "")
            + (prompts["examples"] if with_examples else "")
        )
        ex_block = (
            f"\n\nÄhnliche, bereits eingeordnete Dokumente (Orientierung):\n{_examples_outline(req.examples)}"
            if with_examples
            else ""
        )
        taxonomy_text, doctype_block, tax_block = _build_data_blocks(with_hints=with_hints)
        h_label = " — Hinweis" if with_hints else ""

        def build(body: str) -> str:
            return (
                f"Taxonomie (slug: Name{h_label}):\n{taxonomy_text}"
                f"{doctype_block}{tax_block}{subjects_block}{ex_block}\n\n"
                f"Max. Tags: {req.max_tags}\n\n"
                f"Dokumenttext:\n---\n{body}\n---"
            )

        return system_prompt, build

    system_prompt, _build_user_prompt = _assemble(examples_active, hints_active)
    user_prompt = _build_user_prompt(text)

    # Token-budget guard. The taxonomy + tax_sections outline can be several
    # thousand tokens by themselves; combined with a long document text the
    # prompt has been observed at 8691 tokens against an LLM_CTX of 8192. We
    # tokenize the actual prompt and shrink the document text until it fits.
    # Skipped silently when the Llama-like object lacks ``tokenize`` (test
    # stubs); the static 6000-char cap above is still in force.
    budget = LLM_CTX - _CLASSIFY_MAX_TOKENS - _CLASSIFY_TEMPLATE_HEADROOM
    overhead_tokens = _count_tokens(llm, system_prompt + _build_user_prompt(""))
    if overhead_tokens is not None:
        # Few-shot first: if the examples push the prompt past the window, drop
        # them and recompute before considering the document itself too big.
        if examples_active and budget - overhead_tokens < 64:
            log.info(
                "classify: dropping few-shot examples to fit n_ctx "
                "(overhead=%d budget=%d)",
                overhead_tokens, budget,
            )
            examples_active = False
            system_prompt, _build_user_prompt = _assemble(False, hints_active)
            user_prompt = _build_user_prompt(text)
            overhead_tokens = _count_tokens(llm, system_prompt + _build_user_prompt(""))

        # Hints second: the taxonomy/doctype/tax-section hints are the largest
        # variable contributor. Without them the model still sees every slug +
        # name — just no disambiguation prose. Much better than a hard 413.
        if hints_active and overhead_tokens is not None and budget - overhead_tokens < 64:
            log.info(
                "classify: dropping taxonomy/doctype/tax hints to fit n_ctx "
                "(overhead=%d budget=%d)",
                overhead_tokens, budget,
            )
            hints_active = False
            system_prompt, _build_user_prompt = _assemble(examples_active, False)
            user_prompt = _build_user_prompt(text)
            overhead_tokens = _count_tokens(llm, system_prompt + _build_user_prompt(""))

    if overhead_tokens is not None:
        text_token_budget = budget - overhead_tokens
        if text_token_budget < 64:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"taxonomy+tax_sections too large for context window: "
                    f"overhead={overhead_tokens} budget={budget}"
                ),
            )
        truncated = _truncate_to_tokens(llm, text, text_token_budget)
        if truncated is not None and truncated != text:
            log.info(
                "classify: truncated document text to fit n_ctx (budget=%d tokens)",
                text_token_budget,
            )
            text = truncated
            user_prompt = _build_user_prompt(text)

    # Bounded in-process retry (2 attempts total = 1 retry) for a *single*
    # generation coming back unusable: either non-JSON, or valid JSON that is
    # empty/near-empty (observed in production: a completion that omitted
    # every field without a default — category_slug/title/summary/tags/
    # confidence — while returning in <500ms, i.e. a degenerate short
    # completion, not a real classification attempt). The first attempt decodes
    # greedily, so a second sample would reproduce it exactly unless the retry
    # changes something — see the temperature note below. This class of failure is
    # a one-off sampling artifact, unlike a value that validates as JSON *and*
    # parses into the schema but violates a constraint (e.g. a confidence
    # outside 0..1) — that reflects a real fact about the document and would
    # just fail again identically, so it still raises immediately without a retry
    # (see the schema-mismatch-after-successful-parse path below, which does
    # NOT loop). Bounded here — unlike the caller's queue-level retry — so a
    # persistently failing document still fails fast instead of doubling
    # every request's worst-case latency indefinitely.
    #
    # The empty-output half of this is now largely vestigial: _CLASSIFY_JSON_SCHEMA
    # makes an empty object ungrammatical, so the model cannot produce one in the
    # first place. Kept as a backstop for the case where the grammar does not
    # apply — a binding that ignores the ``schema`` key, or a build whose
    # schema→GBNF conversion rejects it — rather than trusting that it always
    # engages. The non-JSON half is unaffected and still does real work.
    _CLASSIFY_MAX_ATTEMPTS = 2

    for attempt in range(1, _CLASSIFY_MAX_ATTEMPTS + 1):
        # The first attempt decodes greedily (temperature 0). Classification is
        # a labelling task with one right answer, not open-ended generation, so
        # sampling buys nothing here — it only picks between candidates the
        # model already ranks, and it made the pipeline irreproducible: the same
        # document re-classified twice could land in different categories, and a
        # field the model filled in one run could come back null in the next.
        # That is not a hypothetical. It cost real data — `sender` and `doc_date`
        # were written straight through, so a run that happened to stay quiet
        # erased what an earlier one had extracted — and it made the model
        # scoreboard unreadable, because the difference between two runs was
        # partly sampling noise rather than the change under test.
        #
        # Greedy decoding does not make a wrong answer right; it makes a wrong
        # answer *consistent*, which is the difference between a fixable
        # taxonomy/hint problem and unfixable noise. Expect the first scoreboard
        # after this to be able to drop: documents that were landing correctly
        # only by chance now land wrong every time, and that is information, not
        # a regression. (Batching can still flip a near-tie numerically, so this
        # is reproducible rather than guaranteed identical.)
        #
        # Retry variation: a degenerate first sample (empty/near-empty output)
        # reproduces exactly on a second greedy call with the same prompt, so
        # the retry MUST change the sampling — all the more so now that the
        # first attempt is deterministic. Raise the temperature and shed the
        # few-shot examples — pure orientation, and the bulkiest optional prompt
        # block; a small model overwhelmed by a long prompt is a plausible cause
        # of a `{}` completion.
        retry = attempt > 1
        temperature = 0.55 if retry else 0.0
        if retry and examples_active:
            # Keep whatever hint state the budget guard settled on — dropping
            # the examples is the retry's variation; re-adding shed hints would
            # push the prompt back over the window.
            attempt_system, _attempt_build = _assemble(False, hints_active)
            attempt_user = _attempt_build(text)
        else:
            attempt_system, attempt_user = system_prompt, user_prompt

        try:
            completion = await _run_blocking(
                llm.create_chat_completion,
                messages=[
                    {"role": "system", "content": attempt_system},
                    {"role": "user", "content": attempt_user},
                ],
                response_format=_state.get("classify_response_format")
                or _CLASSIFY_RESPONSE_FORMAT,
                temperature=temperature,
                # _CLASSIFY_MAX_TOKENS leaves headroom for the extra tax fields
                # (up to a handful of tax_sections entries) without touching n_ctx.
                max_tokens=_CLASSIFY_MAX_TOKENS,
            )
        except HTTPException:
            raise
        except Exception as exc:  # llama.cpp raises a generic Exception family
            log.exception("llm.create_chat_completion failed")
            raise HTTPException(status_code=500, detail=f"llm failure: {exc}") from exc

        raw = completion["choices"][0]["message"]["content"].strip()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            log.warning(
                "classify attempt %d/%d: LLM returned non-JSON payload: %r",
                attempt, _CLASSIFY_MAX_ATTEMPTS, raw[:200],
            )
            if attempt < _CLASSIFY_MAX_ATTEMPTS:
                continue
            # Persistent non-JSON is the same per-document degenerate phenomenon
            # as an empty object — fall back rather than 502 (which the caller
            # would treat as a transient outage and defer forever).
            return _degenerate_fallback(req, "non-JSON output")

        # Repair UTF-8-as-Latin-1 mojibake at the producer boundary — see the
        # ``_repair_mojibake`` docstring above. Only the free-form German text
        # fields can contain the two-byte UTF-8 codepoints (ä/ö/ü/ß, umlauts) that
        # trigger the bug; slugs, dates and confidences are ASCII.
        _repair_fields(data, ("title", "sender", "document_number", "summary"))
        _repair_tags(data)

        # Document-type facet: when disabled, drop any type the LLM emitted anyway;
        # when enabled, keep the returned slug only if it is in the offered set,
        # otherwise null it (no forced fallback — an untyped document is better than
        # a wrong type). Mirrors the tax_sections whitelist below.
        if not doctype_active:
            data.pop("document_type", None)
            data.pop("document_type_confidence", None)
        else:
            allowed_types = {e.slug for e in req.document_types}
            dt = data.get("document_type")
            if not isinstance(dt, str) or dt not in allowed_types:
                data["document_type"] = None
                data["document_type_confidence"] = 0.0
            elif not isinstance(data.get("document_type_confidence"), (int, float)):
                data["document_type_confidence"] = 0.0

        # If tax detection is off, ignore any tax_* fields the LLM might have
        # hallucinated — they're not validated against a slug whitelist here.
        if not tax_active:
            for k in ("tax_relevant", "tax_year", "tax_year_confidence", "tax_sections"):
                data.pop(k, None)
        else:
            # Drop tax_sections entries whose slug is not in the provided list —
            # the LLM sometimes invents neighbouring labels. The caller also
            # validates, but doing it here keeps the schema-mismatch path
            # tight and the HTTP response tidy.
            allowed = {e.slug for e in req.tax_sections}
            raw_sections = data.get("tax_sections")
            if isinstance(raw_sections, list):
                data["tax_sections"] = [
                    s for s in raw_sections
                    if isinstance(s, dict) and s.get("slug") in allowed
                ]
            # Dump-all backstop: a small classifier sometimes returns the entire
            # offered section list at high confidence when no real match exists
            # (observed: a Grundsteuerbescheid and a Renteninformation each tagged
            # with all 18 sections). Drop the entire tax assignment in that case —
            # better to surface "no tax sections" than poison the user's tax view.
            n = len(data.get("tax_sections") or [])
            if TAX_SECTIONS_MAX > 0 and n > TAX_SECTIONS_MAX:
                log.warning(
                    "classify: dump-all tax_sections (%d > %d) — dropping tax assignment",
                    n, TAX_SECTIONS_MAX,
                )
                data["tax_sections"] = []
                data["tax_relevant"] = False
                data["tax_year"] = None
                data["tax_year_confidence"] = 0.0
            # LLM sometimes emits null for numeric confidence fields — coerce to defaults.
            if data.get("tax_year_confidence") is None:
                data["tax_year_confidence"] = 0.0
            # An implausible tax year is dropped, not fatal. The year is one
            # optional derived field among many, and the classifier regularly
            # mistakes another four-digit number on the page for it (observed:
            # the patient's birth year on a doctor's invoice). Letting that
            # value reach the ClassifyResponse bound below turned a good
            # classification — right category, title, date, sender, sections —
            # into a hard 422 that parks the whole document in `failed`. Same
            # treatment as the document_type and tax_sections whitelists above,
            # and the same as documents/llm-client.ts `parseTaxFields`, which
            # has always nulled out-of-range years on the caller side.
            raw_year = data.get("tax_year")
            sane_year = _sane_tax_year(raw_year)
            if raw_year is not None and sane_year is None:
                log.warning(
                    "classify: implausible tax_year %r — dropping it (kept the rest)",
                    raw_year,
                )
                data["tax_year_confidence"] = 0.0
            data["tax_year"] = sane_year

        if _has_core_fields(data):
            # A parseable, populated classification. Coerce it — a failure here
            # is a constraint violation on real content (e.g. a confidence
            # outside 0..1), which is deterministic: surface it immediately as
            # 422, with NO retry and NO fallback. 422 not 502 so the caller
            # doesn't treat it as a service outage and defer for an unbounded
            # retry (see scan-worker.ts / scan-queue.ts deferJob). No fallback
            # either, because masking a real value bug as "sonstiges" is exactly
            # how the tax_year-range issue stayed invisible for so long.
            #
            # Individual *optional* facets are sanitized above rather than left
            # to fail here — a single implausible derived value (document_type,
            # tax_sections, tax_year) is not worth discarding an otherwise good
            # classification and parking the document in `failed`.
            try:
                return ClassifyResponse(**data)
            except Exception as exc:
                log.warning("LLM payload did not match schema: %r", data)
                raise HTTPException(status_code=422, detail=f"schema mismatch: {exc}") from exc

        # Valid JSON but missing every core field — a degenerate/empty sample.
        # Retry once (with the varied sampling above); if it persists, fall back
        # to a low-confidence "sonstiges" so the document is usable and reviewable
        # instead of dead-ending.
        log.warning(
            "classify attempt %d/%d: payload missing all core fields: %r",
            attempt, _CLASSIFY_MAX_ATTEMPTS, data,
        )
        if attempt < _CLASSIFY_MAX_ATTEMPTS:
            continue
        return _degenerate_fallback(req, "empty/near-empty output")

    # Unreachable: the loop either returns or raises on every path above.
    raise HTTPException(status_code=500, detail="classify: unreachable")


# ─── /json-prompt ──────────────────────────────────────────────────────────────


class JsonPromptRequest(BaseModel):
    """Generic JSON-mode chat completion.

    Used by callers whose prompt isn't the hardcoded document classifier
    (e.g. finance tag-suggestion, free-text-to-AST analysis queries). The
    server only enforces ``response_format={"type": "json_object"}``; the
    caller is responsible for prompting the LLM into the desired shape and
    validating the response.
    """

    prompt: str = Field(..., min_length=1)
    system: str | None = None
    max_tokens: int = Field(default=768, gt=0, le=4096)
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)


# ─── Visual transcription ─────────────────────────────────────────────────────
#
# The narrowest possible use of a vision model: hand it a *crop* of a page and
# ask what characters are printed in it. Not "read this document", not "fix
# this OCR" — transcribe these pixels.
#
# The distinction is not stylistic. A model told to correct OCR output uses its
# language knowledge to do so, which is exactly right for "23 aus oz" → "23 AUG
# 02" and exactly wrong for "7.500" → "7.800" on a bank statement. It cannot
# tell the two situations apart, so it must not be asked to try. The caller
# (documents/ocr-resolver.ts) additionally validates every answer before
# accepting it, and falls back to the OCR reading when validation fails.

VISION_SYSTEM_PROMPT = (
    "You transcribe text from small images of printed documents. "
    "Reproduce exactly the characters that are visibly printed. "
    "Do not translate, expand, reformat, spell-check or complete anything. "
    "Do not use meaning, context or expectation to invent characters. "
    "If a character is not legible, output '?' in its place. "
    "If the image contains no readable text, return an empty string."
)

# Output shape. Constrained server-side into a grammar, like /classify, so a
# chatty model cannot answer with a sentence about what it sees.
VISION_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "json_object",
    "schema": {
        "type": "object",
        "properties": {
            "text": {"type": "string"},
            "confidence": {"type": "number"},
        },
        "required": ["text", "confidence"],
    },
}

# What the caller may say it expects to find. Passed as a *format* hint for the
# output only — never as licence to produce a value of that shape when the
# pixels do not show one.
VISION_EXPECTED_TYPES = ("date", "amount", "iban", "document_number", "text")


class VisionTranscribeRequest(BaseModel):
    """One crop, plus what the OCR engines made of it."""

    image_b64: str = Field(..., min_length=1)
    image_mime: str = Field(default="image/png")
    # The OCR reading, offered to the model as an unreliable hint. Optional:
    # withholding it is the cleanest test of whether the model is transcribing
    # or merely agreeing, and the caller uses that when measuring.
    hint: str | None = None
    expected_type: str | None = None
    max_tokens: int = Field(default=64, gt=0, le=512)


class VisionTranscribeResponse(BaseModel):
    text: str
    confidence: float
    model: str
    processing_ms: int


@app.post("/vision/transcribe", response_model=VisionTranscribeResponse)
async def vision_transcribe(req: VisionTranscribeRequest) -> VisionTranscribeResponse:
    llm = _state["llm"]
    if llm is None:
        raise HTTPException(status_code=503, detail="llm not loaded")
    cfg = _state["config"]
    if not cfg.mmproj_path:
        # A precise 503 rather than a confusing model error: the weights are
        # loaded and answering text prompts, the vision tower simply is not
        # there. Naming the knob is the difference between a five-minute fix
        # and an afternoon.
        raise HTTPException(
            status_code=503,
            detail=(
                "no multimodal projector loaded — set LLM_MMPROJ_PATH (or the "
                "configuration's mmproj_path) to the model's mmproj-*.gguf and "
                "run with LLM_BACKEND=server"
            ),
        )
    if req.expected_type is not None and req.expected_type not in VISION_EXPECTED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"expected_type must be one of {list(VISION_EXPECTED_TYPES)}",
        )

    t0 = time.monotonic()

    instruction = "Transcribe the text visible in this image."
    if req.expected_type and req.expected_type != "text":
        instruction += (
            f" It is expected to be a {req.expected_type.replace('_', ' ')}, but"
            " transcribe what is printed even if it is not."
        )
    if req.hint:
        instruction += (
            f" An OCR engine read it as {req.hint!r}. That reading is unreliable"
            " and may be wrong; use it only as a hint, never as the answer."
        )
    instruction += (
        ' Reply as JSON: {"text": "<what is printed>", "confidence": <0..1 how'
        " certain you are that you read every character correctly>}."
    )

    messages = [
        {"role": "system", "content": VISION_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{req.image_mime};base64,{req.image_b64}"},
                },
                {"type": "text", "text": instruction},
            ],
        },
    ]

    try:
        completion = await _run_blocking(
            llm.create_chat_completion,
            messages=messages,
            response_format=VISION_RESPONSE_SCHEMA,
            # Greedy. A transcription has one right answer, and sampling a
            # second-choice character is precisely the failure mode.
            temperature=0.0,
            max_tokens=req.max_tokens,
            # Generous: a busy classification run holds the single inference
            # worker for up to a minute, and a crop that waits is far better
            # than a crop that 503s and silently leaves the OCR reading in.
            acquire_timeout=60.0,
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("/vision/transcribe: llm.create_chat_completion failed")
        raise HTTPException(status_code=500, detail=f"llm failure: {exc}") from exc

    raw = completion["choices"][0]["message"]["content"].strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        log.warning("/vision/transcribe: model returned non-JSON: %r", raw[:200])
        raise HTTPException(status_code=502, detail=f"model returned invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="model returned non-object JSON")

    text = _repair_mojibake(str(data.get("text", ""))) or ""
    try:
        confidence = float(data.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    log.info(
        "vision transcribe: %d char(s) confidence=%.2f expected=%s time=%dms",
        len(text), confidence, req.expected_type or "-", elapsed_ms,
    )
    return VisionTranscribeResponse(
        text=text,
        confidence=max(0.0, min(1.0, confidence)),
        model=LLM_MODEL_PATH.name,
        processing_ms=elapsed_ms,
    )


# ─── Field assignment ─────────────────────────────────────────────────────────
#
# A second, narrower use of the vision model, for a different failure than
# /vision/transcribe handles.
#
# There, the characters are in doubt. Here they are not: OCR read the page
# fine, but the *pairing* of labels to values could not be derived from the
# geometry — a form whose captions and fields do not line up, a value printed
# somewhere its label does not predict. The question is "which value belongs to
# this label", and answering it needs a view of the whole page rather than a
# crop, because that is precisely the information a crop removes.
#
# The safety property is different too, and stricter. The model is not allowed
# to contribute *content*: the caller checks every returned value against the
# page's own OCR text and drops anything that is not already there. So the
# model can only rearrange what was read, never add to it — which is what makes
# handing over a whole page acceptable at all.

FIELDS_SYSTEM_PROMPT = (
    "You read printed documents and report which value belongs to which label. "
    "Copy values exactly as printed, character for character. "
    "Never translate, reformat, complete or correct a value. "
    "Never invent a value: if a label has no value visibly printed for it, omit "
    "that label entirely from your answer. "
    "Report only the labels you were asked about."
)

FIELDS_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "json_object",
    "schema": {
        "type": "object",
        "properties": {
            "fields": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string"},
                        "value": {"type": "string"},
                    },
                    "required": ["label", "value"],
                },
            }
        },
        "required": ["fields"],
    },
}

# A page carries far more labels than a resolver ever needs answered, and each
# one costs output tokens the model could spend hallucinating. The cap is a
# guard on the request, not a judgement about the page.
MAX_REQUESTED_LABELS = 24


class VisionFieldsRequest(BaseModel):
    """One page image, plus the labels whose values geometry could not find."""

    image_b64: str = Field(..., min_length=1)
    image_mime: str = Field(default="image/png")
    labels: list[str] = Field(..., min_length=1)
    max_tokens: int = Field(default=512, gt=0, le=2048)


class VisionField(BaseModel):
    label: str
    value: str


class VisionFieldsResponse(BaseModel):
    fields: list[VisionField]
    model: str
    processing_ms: int


@app.post("/vision/fields", response_model=VisionFieldsResponse)
async def vision_fields(req: VisionFieldsRequest) -> VisionFieldsResponse:
    llm = _state["llm"]
    if llm is None:
        raise HTTPException(status_code=503, detail="llm not loaded")
    cfg = _state["config"]
    if not cfg.mmproj_path:
        raise HTTPException(
            status_code=503,
            detail=(
                "no multimodal projector loaded — set LLM_MMPROJ_PATH (or the "
                "configuration's mmproj_path) to the model's mmproj-*.gguf and "
                "run with LLM_BACKEND=server"
            ),
        )

    labels = [label.strip() for label in req.labels if label.strip()]
    if not labels:
        raise HTTPException(status_code=400, detail="labels must contain a non-empty entry")
    if len(labels) > MAX_REQUESTED_LABELS:
        raise HTTPException(
            status_code=400,
            detail=f"at most {MAX_REQUESTED_LABELS} labels per request, got {len(labels)}",
        )

    t0 = time.monotonic()
    listed = "\n".join(f"- {label}" for label in labels)
    instruction = (
        "This is a page from a printed document. For each of the following "
        "labels, report the value printed for it on the page:\n"
        f"{listed}\n"
        "Copy each value exactly as printed. Omit any label whose value is not "
        'visibly printed. Reply as JSON: {"fields": [{"label": "...", '
        '"value": "..."}]}.'
    )

    messages = [
        {"role": "system", "content": FIELDS_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{req.image_mime};base64,{req.image_b64}"},
                },
                {"type": "text", "text": instruction},
            ],
        },
    ]

    try:
        completion = await _run_blocking(
            llm.create_chat_completion,
            messages=messages,
            response_format=FIELDS_RESPONSE_SCHEMA,
            temperature=0.0,
            max_tokens=req.max_tokens,
            acquire_timeout=60.0,
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("/vision/fields: llm.create_chat_completion failed")
        raise HTTPException(status_code=500, detail=f"llm failure: {exc}") from exc

    raw = completion["choices"][0]["message"]["content"].strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        log.warning("/vision/fields: model returned non-JSON: %r", raw[:200])
        raise HTTPException(status_code=502, detail=f"model returned invalid JSON: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("fields"), list):
        raise HTTPException(status_code=502, detail="model returned no fields array")

    # Drop anything for a label we did not ask about. The caller validates the
    # *values* against the page text — this only keeps the answer on topic.
    requested = {label.casefold() for label in labels}
    out: list[VisionField] = []
    for entry in data["fields"]:
        if not isinstance(entry, dict):
            continue
        label = _repair_mojibake(str(entry.get("label", ""))) or ""
        value = _repair_mojibake(str(entry.get("value", ""))) or ""
        if not label.strip() or not value.strip():
            continue
        if label.strip().casefold() not in requested:
            continue
        out.append(VisionField(label=label.strip(), value=value.strip()))

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    log.info(
        "vision fields: asked %d, answered %d, time=%dms",
        len(labels), len(out), elapsed_ms,
    )
    return VisionFieldsResponse(fields=out, model=LLM_MODEL_PATH.name, processing_ms=elapsed_ms)


@app.post("/json-prompt")
async def json_prompt(req: JsonPromptRequest) -> dict[str, Any]:
    llm = _state["llm"]
    if llm is None:
        raise HTTPException(status_code=503, detail="llm not loaded")

    messages: list[dict[str, str]] = []
    if req.system:
        messages.append({"role": "system", "content": req.system})
    messages.append({"role": "user", "content": req.prompt})

    try:
        completion = await _run_blocking(
            llm.create_chat_completion,
            messages=messages,
            response_format={"type": "json_object"},
            temperature=req.temperature,
            max_tokens=req.max_tokens,
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("/json-prompt: llm.create_chat_completion failed")
        raise HTTPException(status_code=500, detail=f"llm failure: {exc}") from exc

    raw = completion["choices"][0]["message"]["content"].strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        log.warning("/json-prompt: LLM returned non-JSON: %r", raw[:200])
        raise HTTPException(status_code=502, detail=f"llm returned invalid JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="llm returned non-object JSON")

    # Mojibake repair on shallow string fields — same fix as /classify, only
    # applied to top-level strings and string list members. Finance prompts
    # don't return nested objects, so we don't recurse.
    for k, v in list(data.items()):
        if isinstance(v, str):
            data[k] = _repair_mojibake(v)
        elif isinstance(v, list):
            data[k] = [_repair_mojibake(x) if isinstance(x, str) else x for x in v]

    return data


# ─── /recap-title ──────────────────────────────────────────────────────────────


class RecapTitleRequest(BaseModel):
    """Context for an auto-generated photo-recap (Rückblick) title.

    All fields are optional — the LLM uses what's provided. ``kind`` is the
    only hint about the recap type; everything else is additional signal.
    """

    kind: str = Field(..., min_length=1)
    locale: str = "de"
    place_city: str | None = None
    place_country: str | None = None
    date_range: str | None = None
    years_ago: int | None = None
    person_name: str | None = None
    year: int | None = None
    month_label: str | None = None
    photo_count: int | None = None
    # Span of the recap in days (trip recaps). 1 => single-day outing, which
    # must read as "Ausflug", not a multi-day "Urlaub"/"Reise".
    duration_days: int | None = None
    # Optional free-form keywords from image tags / embedding clusters —
    # helpful for "theme" recaps, harmless for the others.
    keywords: list[str] = Field(default_factory=list)


class RecapTitleResponse(BaseModel):
    title: str
    subtitle: str | None = None


_RECAP_SYSTEM_PROMPT = """Du erzeugst kurze, warmherzige Titel für private Foto-Rückblicke.
Antworte ausschließlich mit gültigem JSON (UTF-8, ohne Markdown-Fences).

Arten von Rückblicken (Feld "Art des Rückblicks"):
- on_this_day: Fotos vom gleichen Kalendertag vor N Jahren.
- trip: eine Reise an einen Ort abseits des Wohnorts.
- person: Fotos mit einer bestimmten Person.
- place: Fotos aus einer Stadt/einem Ort über längere Zeit — das kann auch
  der Wohnort sein. KEINE Reise!
- theme: Fotos zu einem visuellen Thema (siehe Stichwörter).
- recent_highlights: die besten Fotos der letzten Wochen.

Felder:
- title: max. 40 Zeichen, aussagekräftig, deutsch, ohne Anführungszeichen,
  ohne Emojis, ohne Ausrufezeichen.
- subtitle: max. 80 Zeichen, ergänzender Untertitel (z.B. Zeitraum, Ort).
  null wenn nichts Sinnvolles ergänzbar ist.

Strikte Regeln — halte dich nur an den gegebenen Kontext:
- Erfinde nichts: keine Orte, Länder, Himmelsrichtungen ("nördlich",
  "südlich"), Marken- oder Personennamen, die nicht im Kontext stehen.
- Sprich nur bei Art "trip" von einer Reise/einem Urlaub/"unterwegs".
  Bei allen anderen Arten sind die Fotos NICHT zwingend auf Reisen
  entstanden.
- Stammen die Fotos alle vom selben Tag (Dauer: 1 Tag), ist es ein
  Ausflug / Tagesausflug — nenne es NICHT "Urlaub", "Reise" oder
  "Wochenende", denn das setzt mehrere Tage voraus.
- Erfinde keine Zeitspannen ("letzte X Jahre", "seit X Jahren") — nutze
  nur den Zeitraum aus dem Kontext, falls vorhanden.
- KEINE Zahlen im Titel oder Untertitel: keine Fotoanzahl, keine
  Tagesanzahl ("124 Tage", "63 Fotos"), keine Jahreszahlen — es sei denn,
  die exakte Zahl steht wörtlich im Kontext.
- Erfinde keine Aktivitäten ("Wanderabenteuer", "Nachtigallen"), die nicht
  in den Stichwörtern stehen. Halte dich an das, was gegeben ist.
- Verwende korrekte deutsche Grammatik und Deklination (z.B. "an der
  Nordsee", nicht "an der Nordseee").
- Fehlt ein Ort im Kontext, dann titel ohne Ortsbezug (z.B. über die
  Jahreszeit, das Jahr oder die Person).
- Nenne den Ort im Titel nicht zusammen mit dem Suffix "Trip",
  "Aufenthalt" o. Ä. — benenne lieber das Erlebnis oder den Ort allein.
- Vermeide nichtssagende Ortsfloskeln und Klischees: KEIN "in der Fremde",
  "in fremden Landen", "in der Ferne", und KEINE generischen Stadtteil-
  Bezeichnungen wie "Innere Stadt", "Innenstadt", "Altstadt", "Neustadt",
  "Zentrum" oder "Stadtmitte" — auch dann nicht, wenn ähnliche Wörter in
  den Stichwörtern auftauchen.

Ton: freundlich, nüchtern, erinnerungsvoll. Keine Floskeln wie "Zurück in
der Zeit". Vermeide Redundanz zwischen Titel und Untertitel."""


def _recap_context(req: RecapTitleRequest) -> str:
    parts: list[str] = [f"Art des Rückblicks: {req.kind}"]
    if req.person_name:
        parts.append(f"Person: {req.person_name}")
    if req.place_city:
        parts.append(f"Ort: {req.place_city}")
    if req.place_country and req.place_country != req.place_city:
        parts.append(f"Land: {req.place_country}")
    if req.date_range:
        parts.append(f"Zeitraum: {req.date_range}")
    if req.year is not None:
        parts.append(f"Jahr: {req.year}")
    if req.years_ago is not None:
        parts.append(f"Vor {req.years_ago} Jahr(en)")
    if req.month_label:
        parts.append(f"Monat: {req.month_label}")
    if req.duration_days is not None:
        parts.append(f"Dauer: {req.duration_days} Tag(e)")
    # photo_count intentionally omitted — it adds no value to the title.
    if req.keywords:
        parts.append("Stichwörter: " + ", ".join(req.keywords[:8]))
    return "\n".join(parts)


@app.post("/recap-title", response_model=RecapTitleResponse)
async def recap_title(req: RecapTitleRequest) -> RecapTitleResponse:
    llm = _state["llm"]
    if llm is None:
        raise HTTPException(status_code=503, detail="llm not loaded")

    user_prompt = (
        f"Kontext:\n{_recap_context(req)}\n\n"
        "Erzeuge einen passenden Titel (und optional Untertitel) als JSON "
        "mit den Feldern title und subtitle."
    )

    try:
        completion = await _run_blocking(
            llm.create_chat_completion,
            messages=[
                {"role": "system", "content": _RECAP_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.5,
            max_tokens=160,
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("llm.create_chat_completion failed for /recap-title")
        raise HTTPException(status_code=500, detail=f"llm failure: {exc}") from exc

    raw = completion["choices"][0]["message"]["content"].strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        log.warning("/recap-title: LLM returned non-JSON: %r", raw[:200])
        raise HTTPException(status_code=502, detail=f"llm returned invalid JSON: {exc}") from exc

    title_raw = str(data.get("title") or "").strip()
    if not title_raw:
        raise HTTPException(status_code=502, detail="llm returned empty title")
    # Repair UTF-8-as-Latin-1 mojibake at the producer boundary before the
    # string ever reaches the Encore caller / DB. llama-cpp-python with the
    # JSON-grammar response format splits tokens at multi-byte UTF-8
    # boundaries and occasionally re-decodes a ``C3 BC`` codepoint as two
    # separate Latin-1 chars ("ü" → "Ã¼"). See ``_repair_mojibake`` above.
    title = (_repair_mojibake(title_raw) or "")[:60]
    subtitle_raw = data.get("subtitle")
    subtitle = (_repair_mojibake(str(subtitle_raw).strip()) or "")[:120] if subtitle_raw else None
    if subtitle == "":
        subtitle = None
    return RecapTitleResponse(title=title, subtitle=subtitle)
