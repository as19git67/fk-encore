"""The set of knobs that decide *which* model the service runs and *how*.

Historically these were module-level constants in ``main.py``, read from the
environment once at import. They are gathered into a value object here because
the service can now be pointed at a different model at runtime (``POST
/reload``), which needs a config that can be replaced rather than one baked
into globals.

Precedence is deliberately conservative:

1. ``${MODELS_DIR}/.active_config.json`` — written only when someone activates
   a configuration through the admin UI.
2. the environment — what compose/.env supply.

A deployment that never touches the UI therefore has no such file and keeps
running exactly on its environment values, including across image updates.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

ACTIVE_CONFIG_FILENAME = ".active_config.json"

BACKENDS = ("inproc", "server")
ACCELERATORS = ("cpu", "cuda")
# ggml KV-cache element types we allow. Mirrored by _GGML_KV_TYPES in main.py,
# which additionally maps them onto ggml enum values.
KV_TYPES = ("f16", "q8_0", "q5_1", "q5_0", "q4_0")
REASONING_MODES = ("off", "auto", "think")

# Guardrails for values that arrive over HTTP. Wide on purpose — they exist to
# reject nonsense (a negative context, a five-million-token window) rather than
# to encode a house style.
CTX_MIN, CTX_MAX = 512, 1_048_576
BATCH_MIN, BATCH_MAX = 1, 1_048_576


def _env_int(name: str, default: int) -> int:
    """``os.environ.get(k, default)`` only falls back when the key is *absent*;
    compose passes ``${VAR:-}`` for unset overrides, which arrives as "" and
    would blow up ``int()``. Unwrap that explicitly."""

    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return int(raw)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_str(name: str, default: str) -> str:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw


class ConfigError(ValueError):
    """An invalid configuration. Raised on both env and API input so the two
    paths reject the same values."""


@dataclass(frozen=True)
class LlmConfig:
    """Everything needed to load a model and, for the server backend, to launch
    the llama-server that owns it.

    Frozen because a reload swaps the whole object rather than mutating fields:
    a half-applied config (new context, old model) is not a state any code here
    should have to reason about.
    """

    model_path: Path

    backend: str = "inproc"
    accelerator: str = "cpu"
    ctx: int = 8192
    threads: int = 0  # 0 = let the backend choose
    gpu_layers: int = 0
    batch: int = 512
    ubatch: int = 512
    flash_attn: bool = False
    kv_type: str = "f16"

    # ── server backend only ──────────────────────────────────────────────────
    # Number of leading layers whose MoE expert tensors are kept in system RAM.
    # 0 is a no-op and correct for a dense model.
    n_cpu_moe: int = 0
    # Multimodal projector ("mmproj") handed to llama-server with --mmproj.
    #
    # llama.cpp keeps a vision model's image encoder in a file *separate* from
    # the GGUF weights, so an image-text-to-text model such as Gemma 4 loads
    # text-only unless this is supplied — the model can see, the server cannot.
    # Empty means text-only, which is the default and what every existing
    # deployment gets.
    #
    # Server backend only: llama-cpp-python needs a per-family chat handler for
    # images, which the pinned CPU version does not provide, so `inproc` stays
    # text-only regardless of this value.
    mmproj_path: str = ""
    reasoning: str = "off"
    server_url: str = "http://127.0.0.1:8080"
    server_extra_args: str = ""
    server_ready_timeout: int = 900
    server_request_timeout: int = 900

    # ── provenance / display ─────────────────────────────────────────────────
    # Set when the config came from a database row; empty when it came from the
    # environment. Purely informational — surfaced in /healthz so an operator
    # can see which named configuration is loaded.
    label: str = ""
    config_id: int | None = None
    model_url: str = ""
    model_sha256: str = ""
    extra_urls: tuple[str, ...] = field(default_factory=tuple)

    # ── construction ─────────────────────────────────────────────────────────

    @classmethod
    def from_env(cls) -> "LlmConfig":
        models_dir = Path(os.environ.get("MODELS_DIR") or "/models")
        default_model = str(models_dir / "qwen2.5-7b-instruct-q4_k_m.gguf")
        extra = _env_str("LLM_MODEL_EXTRA_URLS", "").split()
        cfg = cls(
            model_path=Path(_env_str("LLM_MODEL_PATH", default_model)),
            backend=_env_str("LLM_BACKEND", "inproc").lower(),
            accelerator=_env_str("LLM_ACCELERATOR", "cpu").lower(),
            ctx=_env_int("LLM_CTX", 8192),
            threads=_env_int("LLM_THREADS", os.cpu_count() or 4),
            gpu_layers=_env_int("LLM_GPU_LAYERS", 0),
            batch=_env_int("LLM_BATCH", 512),
            ubatch=_env_int("LLM_UBATCH", 512),
            flash_attn=_env_bool("LLM_FLASH_ATTN", False),
            kv_type=_env_str("LLM_KV_TYPE", "f16").lower(),
            n_cpu_moe=_env_int("LLM_NCMOE", 0),
            mmproj_path=_env_str("LLM_MMPROJ_PATH", ""),
            reasoning=_env_str("LLM_REASONING", "off").lower(),
            server_url=_env_str("LLM_SERVER_URL", "http://127.0.0.1:8080").rstrip("/"),
            server_extra_args=_env_str("LLM_SERVER_EXTRA_ARGS", ""),
            server_ready_timeout=_env_int("LLM_SERVER_READY_TIMEOUT", 900),
            server_request_timeout=_env_int("LLM_SERVER_REQUEST_TIMEOUT", 900),
            model_url=_env_str("LLM_MODEL_URL", ""),
            model_sha256=_env_str("LLM_MODEL_SHA256", ""),
            extra_urls=tuple(extra),
        )
        cfg.validate()
        return cfg

    @classmethod
    def from_dict(cls, data: dict[str, Any], *, models_dir: Path) -> "LlmConfig":
        """Build a config from a JSON payload (the persisted file, or a
        ``/reload`` request body).

        The model is named by *basename* rather than by path: the same
        configuration row has to work regardless of where the volume is
        mounted, and accepting a caller-supplied absolute path would let an
        HTTP request point the loader anywhere on the filesystem.
        """

        filename = str(data.get("model_filename") or "").strip()
        if not filename:
            raise ConfigError("model_filename is required")
        if "/" in filename or filename in {".", ".."}:
            raise ConfigError("model_filename must be a bare file name, not a path")

        base = cls(model_path=models_dir / filename)
        threads = data.get("threads")
        cfg = replace(
            base,
            backend=str(data.get("backend", base.backend)).lower(),
            accelerator=str(data.get("accelerator", base.accelerator)).lower(),
            ctx=int(data.get("ctx_size", base.ctx)),
            threads=int(threads) if threads not in (None, "") else 0,
            gpu_layers=int(data.get("gpu_layers", base.gpu_layers)),
            batch=int(data.get("batch_size", base.batch)),
            ubatch=int(data.get("ubatch_size", base.ubatch)),
            flash_attn=bool(data.get("flash_attn", base.flash_attn)),
            kv_type=str(data.get("kv_type", base.kv_type)).lower(),
            n_cpu_moe=int(data.get("n_cpu_moe", base.n_cpu_moe)),
            mmproj_path=str(data.get("mmproj_path") or ""),
            reasoning=str(data.get("reasoning", base.reasoning)).lower(),
            server_url=str(data.get("server_url", base.server_url)).rstrip("/"),
            server_extra_args=str(data.get("server_extra_args") or ""),
            server_ready_timeout=int(data.get("ready_timeout_s", base.server_ready_timeout)),
            server_request_timeout=int(data.get("request_timeout_s", base.server_request_timeout)),
            label=str(data.get("label") or ""),
            config_id=int(data["config_id"]) if data.get("config_id") is not None else None,
            model_url=str(data.get("model_url") or ""),
            model_sha256=str(data.get("model_sha256") or ""),
            extra_urls=tuple(str(u) for u in (data.get("extra_urls") or ())),
        )
        cfg.validate()
        return cfg

    def to_dict(self) -> dict[str, Any]:
        """Round-trips through :meth:`from_dict` given the same models_dir."""

        return {
            "model_filename": self.model_path.name,
            "backend": self.backend,
            "accelerator": self.accelerator,
            "ctx_size": self.ctx,
            "threads": self.threads or None,
            "gpu_layers": self.gpu_layers,
            "batch_size": self.batch,
            "ubatch_size": self.ubatch,
            "flash_attn": self.flash_attn,
            "kv_type": self.kv_type,
            "n_cpu_moe": self.n_cpu_moe,
            "mmproj_path": self.mmproj_path,
            "reasoning": self.reasoning,
            "server_url": self.server_url,
            "server_extra_args": self.server_extra_args,
            "ready_timeout_s": self.server_ready_timeout,
            "request_timeout_s": self.server_request_timeout,
            "label": self.label,
            "config_id": self.config_id,
            "model_url": self.model_url,
            "model_sha256": self.model_sha256,
            "extra_urls": list(self.extra_urls),
        }

    # ── validation ───────────────────────────────────────────────────────────

    def validate(self) -> None:
        if self.backend not in BACKENDS:
            raise ConfigError(f"backend must be one of {list(BACKENDS)}, got {self.backend!r}")
        if self.accelerator not in ACCELERATORS:
            raise ConfigError(f"accelerator must be one of {list(ACCELERATORS)}, got {self.accelerator!r}")
        if self.kv_type not in KV_TYPES:
            raise ConfigError(f"kv_type must be one of {list(KV_TYPES)}, got {self.kv_type!r}")
        if self.reasoning not in REASONING_MODES:
            raise ConfigError(f"reasoning must be one of {list(REASONING_MODES)}, got {self.reasoning!r}")
        if not CTX_MIN <= self.ctx <= CTX_MAX:
            raise ConfigError(f"ctx_size must be between {CTX_MIN} and {CTX_MAX}, got {self.ctx}")
        if not BATCH_MIN <= self.batch <= BATCH_MAX:
            raise ConfigError(f"batch_size must be between {BATCH_MIN} and {BATCH_MAX}, got {self.batch}")
        if not BATCH_MIN <= self.ubatch <= BATCH_MAX:
            raise ConfigError(f"ubatch_size must be between {BATCH_MIN} and {BATCH_MAX}, got {self.ubatch}")
        if self.ubatch > self.batch:
            raise ConfigError("ubatch_size must not exceed batch_size")
        if self.threads < 0:
            raise ConfigError("threads must not be negative")
        if self.n_cpu_moe < 0:
            raise ConfigError("n_cpu_moe must not be negative")
        if self.mmproj_path and self.backend != "server":
            raise ConfigError(
                "mmproj_path needs backend=server; the in-process runtime cannot "
                "load a multimodal projector"
            )
        if self.server_ready_timeout <= 0 or self.server_request_timeout <= 0:
            raise ConfigError("timeouts must be positive")
        if not self.server_url.startswith(("http://", "https://")):
            raise ConfigError(f"server_url must be an http(s) URL, got {self.server_url!r}")


# ─── Persistence ──────────────────────────────────────────────────────────────


def active_config_path(models_dir: Path) -> Path:
    return models_dir / ACTIVE_CONFIG_FILENAME


def load_active(models_dir: Path) -> LlmConfig | None:
    """Return the persisted configuration, or ``None`` when there is none.

    A malformed file is *not* fatal: it would otherwise wedge the service into
    a crash loop that no HTTP endpoint could repair, since every endpoint lives
    behind the same startup. The caller falls back to the environment and logs.
    """

    path = active_config_path(models_dir)
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ConfigError(f"{path} does not contain a JSON object")
    return LlmConfig.from_dict(data, models_dir=models_dir)


def save_active(models_dir: Path, cfg: LlmConfig) -> Path:
    """Persist *cfg* atomically, so a crash mid-write cannot leave a truncated
    file that the next start would refuse to parse."""

    path = active_config_path(models_dir)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg.to_dict(), indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(path)
    return path


def clear_active(models_dir: Path) -> bool:
    """Drop the persisted configuration, returning the service to its
    environment values on the next start. True when a file was removed."""

    path = active_config_path(models_dir)
    if not path.exists():
        return False
    path.unlink()
    return True
