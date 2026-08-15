"""Ownership of the llama.cpp ``llama-server`` subprocess.

Until now entrypoint.sh launched the sidecar and the FastAPI app merely
attached to it over HTTP. That works for a fixed model, but not for switching
models at runtime: swapping the model means stopping the old server and
starting a new one with different arguments, and the app cannot do that to a
sibling process it did not spawn. So the app owns it.

The property entrypoint.sh provided with ``wait -n`` — a llama-server that dies
takes the container down, rather than leaving a service that 503s forever — is
preserved here by *on_unexpected_exit*, which main.py wires to a SIGTERM
against its own process. A stop we asked for is not "unexpected" and does not
trigger it.
"""

from __future__ import annotations

import logging
import os
import signal
import subprocess
import threading
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from llm_config import LlmConfig

log = logging.getLogger("llm-service.llama-server")

DEFAULT_BINARY = "/usr/local/bin/llama-server"


def resolve_binary() -> str:
    return os.environ.get("LLAMA_SERVER_BIN") or DEFAULT_BINARY


def server_port(url: str) -> int:
    """Port the sidecar should bind, derived from the URL the app will call, so
    there is a single source of truth for both ends of the loopback."""

    parsed = urlparse(url)
    if parsed.port is None:
        raise ValueError(f"cannot derive a port from LLM_SERVER_URL={url!r}")
    return parsed.port


def build_args(cfg: LlmConfig) -> list[str]:
    """Command line for *cfg*. Mirrors what entrypoint.sh used to assemble."""

    args = [
        "--model", str(cfg.model_path),
        "--host", "127.0.0.1",
        "--port", str(server_port(cfg.server_url)),
        "--ctx-size", str(cfg.ctx),
        "--batch-size", str(cfg.batch),
        "--ubatch-size", str(cfg.ubatch),
        "--n-gpu-layers", str(cfg.gpu_layers),
        "--cache-type-k", cfg.kv_type,
        "--cache-type-v", cfg.kv_type,
        # The GGUF's own chat template. Required for correct Qwen3-family
        # formatting; llama.cpp's built-in fallbacks are close but not
        # identical, and a mis-templated system prompt degrades classification
        # quietly rather than loudly.
        "--jinja",
        "--no-webui",
    ]

    # Expert offload — the reason this backend exists at all. 0 is a no-op.
    if cfg.n_cpu_moe > 0:
        args += ["--n-cpu-moe", str(cfg.n_cpu_moe)]
    # 0 means "let llama.cpp pick".
    if cfg.threads > 0:
        args += ["--threads", str(cfg.threads)]
    args += ["--flash-attn", "on" if cfg.flash_attn else "off"]
    # Thinking off by default: /classify constrains the completion with a JSON
    # grammar, so a reasoning block cannot be emitted anyway — but a hybrid
    # model left in "auto" spends its budget trying.
    args += ["--reasoning", cfg.reasoning]
    # Escape hatch for flags this wrapper does not model (e.g. a hand-tuned
    # --override-tensor split). Word-split on purpose.
    if cfg.server_extra_args.strip():
        args += cfg.server_extra_args.split()
    return args


class LlamaServerProcess:
    """Start/stop a llama-server, and notice when it dies on its own."""

    def __init__(
        self,
        binary: str | None = None,
        on_unexpected_exit: Callable[[int], None] | None = None,
    ) -> None:
        self._binary = binary or resolve_binary()
        self._on_unexpected_exit = on_unexpected_exit
        self._proc: subprocess.Popen[bytes] | None = None
        self._watcher: threading.Thread | None = None
        # Guards the (_proc, _stopping) pair against a stop() racing the
        # watcher thread's exit handling.
        self._lock = threading.Lock()
        self._stopping = False

    @property
    def binary(self) -> str:
        return self._binary

    @property
    def available(self) -> bool:
        """False when this image ships no llama-server. Pointing LLM_BACKEND=server
        at a llama-server running elsewhere (another compose service, another
        host) is a legitimate setup; in that case we never manage a process and
        the readiness wait against the URL is the only check."""

        return Path(self._binary).is_file() and os.access(self._binary, os.X_OK)

    @property
    def is_running(self) -> bool:
        proc = self._proc
        return proc is not None and proc.poll() is None

    def start(self, cfg: LlmConfig) -> None:
        if self.is_running:
            raise RuntimeError("llama-server is already running")
        if not self.available:
            raise FileNotFoundError(f"{self._binary} is not an executable file")

        args = [self._binary, *build_args(cfg)]
        log.info("Starting llama-server: %s", " ".join(args))
        with self._lock:
            self._stopping = False
            # stdout/stderr are inherited so llama.cpp's own logging lands in
            # the container log, exactly as it did under entrypoint.sh.
            self._proc = subprocess.Popen(args)
            self._watcher = threading.Thread(
                target=self._watch, args=(self._proc,), name="llama-server-watch", daemon=True
            )
            self._watcher.start()

    def stop(self, timeout: float = 60.0) -> None:
        """Ask the server to exit and wait for it.

        Marked as deliberate first, so the watcher does not mistake the exit
        for a crash and take the container down with it.
        """

        with self._lock:
            proc = self._proc
            if proc is None or proc.poll() is not None:
                self._proc = None
                return
            self._stopping = True

        log.info("Stopping llama-server (pid=%d)", proc.pid)
        proc.terminate()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            log.warning("llama-server did not exit within %.0fs — killing", timeout)
            proc.kill()
            proc.wait(timeout=30)

        watcher = self._watcher
        if watcher is not None:
            watcher.join(timeout=5)
        with self._lock:
            self._proc = None
            self._watcher = None

    def _watch(self, proc: subprocess.Popen[bytes]) -> None:
        status = proc.wait()
        with self._lock:
            deliberate = self._stopping
        if deliberate:
            log.info("llama-server exited as requested (status=%s)", status)
            return
        log.error("llama-server exited unexpectedly (status=%s)", status)
        if self._on_unexpected_exit is not None:
            self._on_unexpected_exit(status)


def terminate_own_process(status: int) -> None:
    """Default *on_unexpected_exit*: bring the whole container down.

    A llama-server that died is not something the app can recover from — the
    model is gone and every inference endpoint would 503 — and compose's
    restart policy does a far better job of getting back to a working state
    than a half-alive process would.
    """

    log.error("llama-server died (status=%s) — shutting the service down", status)
    os.kill(os.getpid(), signal.SIGTERM)
