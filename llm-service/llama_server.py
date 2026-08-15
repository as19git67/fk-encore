"""Client for a llama.cpp ``llama-server`` sidecar.

Why this exists at all: ``llama-cpp-python`` does not expose llama.cpp's
tensor-buffer overrides — ``llama_model_params.tensor_buft_overrides`` is
declared in its ctypes struct but marked ``# NOTE: unused``, and ``Llama``
has no keyword for it. That override is exactly what a Mixture-of-Experts
model needs to run on a GPU too small to hold it: ``--n-cpu-moe N`` keeps the
*expert* tensors of the first N layers in system RAM while attention, the
shared weights and the KV cache stay on the GPU. Without it the only lever is
``n_gpu_layers``, which spills whole layers — attention included — and
collapses throughput.

``llama-server`` accepts the flag, so the GPU image runs the model there and
this class speaks to it over HTTP. It is deliberately shaped like the subset
of ``llama_cpp.Llama`` that ``main.py`` actually touches — ``tokenize``,
``detokenize`` and ``create_chat_completion`` — so the request handlers work
against either backend without branching.

Synchronous by design (stdlib ``urllib`` only, no new dependency): every call
site already runs inside ``_run_blocking``'s single-worker executor.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from typing import Any

log = logging.getLogger("llm-service.llama-server")


class LlamaServerError(RuntimeError):
    """Raised for transport failures and non-2xx replies from llama-server."""


class LlamaServerClient:
    """Minimal HTTP client for the endpoints ``main.py`` needs.

    ``request_timeout`` is generous on purpose: with the experts on CPU a
    five-figure prompt can take minutes to prefill, and a timeout firing
    mid-inference would surface as a 500 that the app's llm-client treats as
    a failed classification.
    """

    def __init__(self, base_url: str, request_timeout: float = 600.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.request_timeout = request_timeout

    # ── transport ─────────────────────────────────────────────────────────

    def _post(self, path: str, payload: dict[str, Any], timeout: float | None = None) -> Any:
        return self._request("POST", path, payload, timeout)

    def _get(self, path: str, timeout: float | None = None) -> Any:
        return self._request("GET", path, None, timeout)

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        timeout: float | None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.request_timeout) as resp:
                body = resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise LlamaServerError(f"{method} {path} -> HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise LlamaServerError(f"{method} {path} -> {exc.reason}") from exc
        except OSError as exc:  # socket timeouts and friends
            raise LlamaServerError(f"{method} {path} -> {exc}") from exc

        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise LlamaServerError(f"{method} {path} returned non-JSON body") from exc

    # ── lifecycle ─────────────────────────────────────────────────────────

    def wait_until_ready(self, timeout_s: float, poll_interval: float = 2.0) -> dict[str, Any]:
        """Block until ``/props`` answers, or raise once *timeout_s* elapses.

        ``/health`` replies 503 while the model is still loading, and loading a
        MoE model whose experts stream into system RAM is slow — minutes on a
        cold page cache. The deadline therefore has to be a deployment knob,
        not a constant.
        """

        deadline = time.monotonic() + timeout_s
        last_error: Exception | None = None
        attempt = 0
        while time.monotonic() < deadline:
            attempt += 1
            try:
                props = self._get("/props", timeout=10.0)
                if isinstance(props, dict):
                    return props
                last_error = LlamaServerError(f"/props returned {type(props).__name__}, expected object")
            except LlamaServerError as exc:
                last_error = exc
                if attempt == 1 or attempt % 15 == 0:
                    log.info("waiting for llama-server at %s (%s)", self.base_url, exc)
            time.sleep(poll_interval)

        raise LlamaServerError(
            f"llama-server at {self.base_url} not ready within {timeout_s:.0f}s: {last_error}"
        )

    # ── llama_cpp.Llama-compatible surface ────────────────────────────────

    def tokenize(self, text: bytes | str, add_bos: bool = False, special: bool = False) -> list[int]:
        """Mirror of ``Llama.tokenize``.

        The parameter names come from llama-cpp-python (``add_bos``,
        ``special``); llama-server calls the same two things ``add_special``
        and ``parse_special``.
        """

        content = text.decode("utf-8", errors="replace") if isinstance(text, bytes) else text
        result = self._post(
            "/tokenize",
            {"content": content, "add_special": add_bos, "parse_special": special},
            timeout=60.0,
        )
        tokens = result.get("tokens") if isinstance(result, dict) else None
        if not isinstance(tokens, list):
            raise LlamaServerError("/tokenize returned no token list")
        return tokens

    def detokenize(self, tokens: list[int]) -> bytes:
        """Mirror of ``Llama.detokenize`` — bytes out, as the caller expects."""

        result = self._post("/detokenize", {"tokens": list(tokens)}, timeout=60.0)
        content = result.get("content") if isinstance(result, dict) else None
        if not isinstance(content, str):
            raise LlamaServerError("/detokenize returned no content")
        return content.encode("utf-8")

    def create_chat_completion(
        self,
        messages: list[dict[str, Any]],
        response_format: dict[str, Any] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        **extra: Any,
    ) -> dict[str, Any]:
        """Mirror of ``Llama.create_chat_completion`` over ``/v1/chat/completions``.

        ``response_format`` passes through untouched: llama-server reads the
        same ``{"type": "json_object", "schema": {...}}`` shape that
        llama-cpp-python does and converts the schema to a GBNF grammar
        server-side, so ``/classify``'s output stays grammar-constrained.
        """

        payload: dict[str, Any] = {"messages": messages}
        if response_format is not None:
            payload["response_format"] = response_format
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        payload.update(extra)

        result = self._post("/v1/chat/completions", payload)
        if not isinstance(result, dict) or not result.get("choices"):
            raise LlamaServerError("/v1/chat/completions returned no choices")

        # A reasoning model served with --jinja puts its scratchpad in
        # `reasoning_content` and leaves `content` as the answer alone. When a
        # build does not split them the JSON grammar still applies to the whole
        # completion, so an absent `content` is a real failure, not a variant.
        message = result["choices"][0].get("message") or {}
        if not isinstance(message.get("content"), str):
            raise LlamaServerError("/v1/chat/completions returned a choice without text content")
        return result
