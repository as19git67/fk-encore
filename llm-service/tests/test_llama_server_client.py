"""Tests for the llama-server backend client.

The class exists to be a drop-in for the slice of ``llama_cpp.Llama`` that
``main.py`` calls, so these tests pin exactly that: the wire shapes
llama-server expects, and the return shapes ``main.py`` assumes.

A local ``http.server`` stands in for llama-server — a stubbed
``urllib.request.urlopen`` would test our mock instead of the real socket
path, and the socket path is where the timeouts and error mapping live.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from llama_server import LlamaServerClient, LlamaServerError


class _Handler(BaseHTTPRequestHandler):
    """Serves canned replies from ``routes``; records every request body."""

    routes: dict[str, tuple[int, object]] = {}
    received: list[tuple[str, dict]] = []

    def log_message(self, *args):  # silence stderr noise during tests
        pass

    def _respond(self, path: str, body: dict | None) -> None:
        type(self).received.append((path, body or {}))
        status, payload = type(self).routes.get(path, (404, {"error": "no route"}))
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler's naming
        self._respond(self.path, None)

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        self._respond(self.path, body)


@pytest.fixture
def server():
    """Yield a factory that starts the stub with the given routes."""

    httpd: HTTPServer | None = None

    def start(routes: dict[str, tuple[int, object]]) -> LlamaServerClient:
        nonlocal httpd
        _Handler.routes = routes
        _Handler.received = []
        httpd = HTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        host, port = httpd.server_address[0], httpd.server_address[1]
        return LlamaServerClient(f"http://{host}:{port}", request_timeout=5.0)

    yield start

    if httpd is not None:
        httpd.shutdown()
        httpd.server_close()


def test_tokenize_maps_parameter_names_and_returns_ids(server):
    """``add_bos``/``special`` are llama-cpp-python's names for what
    llama-server calls ``add_special``/``parse_special``."""

    client = server({"/tokenize": (200, {"tokens": [1, 2, 3]})})

    assert client.tokenize(b"hallo welt", add_bos=False, special=False) == [1, 2, 3]

    path, body = _Handler.received[-1]
    assert path == "/tokenize"
    assert body == {"content": "hallo welt", "add_special": False, "parse_special": False}


def test_detokenize_returns_bytes(server):
    """``main._truncate_to_tokens`` decodes the result itself, so bytes out."""

    client = server({"/detokenize": (200, {"content": "Grüße"})})

    assert client.detokenize([1, 2]) == "Grüße".encode("utf-8")


def test_create_chat_completion_passes_response_format_through(server):
    """The JSON schema must reach llama-server unmodified — it builds the
    grammar that keeps /classify's output well-formed."""

    schema = {"type": "object", "properties": {"category_slug": {"type": "string"}}}
    client = server({
        "/v1/chat/completions": (200, {"choices": [{"message": {"content": '{"category_slug":"x"}'}}]}),
    })

    result = client.create_chat_completion(
        messages=[{"role": "user", "content": "hi"}],
        response_format={"type": "json_object", "schema": schema},
        temperature=0.2,
        max_tokens=512,
    )

    assert result["choices"][0]["message"]["content"] == '{"category_slug":"x"}'
    _, body = _Handler.received[-1]
    assert body["response_format"] == {"type": "json_object", "schema": schema}
    assert body["temperature"] == 0.2
    assert body["max_tokens"] == 512


def test_create_chat_completion_omits_unset_optionals(server):
    """An absent temperature must not become ``null`` on the wire — that is a
    type error to llama-server, not "use your default"."""

    client = server({
        "/v1/chat/completions": (200, {"choices": [{"message": {"content": "{}"}}]}),
    })

    client.create_chat_completion(messages=[{"role": "user", "content": "hi"}])

    _, body = _Handler.received[-1]
    assert set(body) == {"messages"}


def test_http_error_becomes_llama_server_error(server):
    """/classify turns this into a 500; a raw URLError would escape as a
    generic 500 without the server's own message."""

    client = server({"/v1/chat/completions": (500, {"error": "context shift failed"})})

    with pytest.raises(LlamaServerError, match="context shift failed"):
        client.create_chat_completion(messages=[{"role": "user", "content": "hi"}])


def test_completion_without_text_content_is_an_error(server):
    """A reasoning-only completion has no answer in it; treating the missing
    content as an empty string would land in the JSON parser instead."""

    client = server({
        "/v1/chat/completions": (200, {"choices": [{"message": {"reasoning_content": "hmm"}}]}),
    })

    with pytest.raises(LlamaServerError, match="text content"):
        client.create_chat_completion(messages=[{"role": "user", "content": "hi"}])


def test_wait_until_ready_returns_props(server):
    client = server({"/props": (200, {"model_path": "/models/x.gguf"})})

    assert client.wait_until_ready(timeout_s=5.0)["model_path"] == "/models/x.gguf"


def test_wait_until_ready_raises_when_never_ready(server):
    """Startup must fail loudly: the compose healthcheck is what turns this
    into a restart, and it only fires if the app does not come up 'ok'."""

    client = server({"/props": (503, {"error": "loading model"})})

    with pytest.raises(LlamaServerError, match="not ready within"):
        client.wait_until_ready(timeout_s=1.0, poll_interval=0.2)


def test_server_backend_keeps_the_json_schema(monkeypatch):
    """In server mode the grammar is built by llama-server, so the local
    pre-flight is skipped — but the schema itself must survive. Dropping to a
    bare json_object here would quietly re-open the empty-'{}' completion hole
    that _CLASSIFY_JSON_SCHEMA closes."""

    import main

    monkeypatch.setattr(main, "LLM_BACKEND", "server")
    resolved = main._resolve_classify_response_format()

    assert resolved == main._CLASSIFY_RESPONSE_FORMAT
    assert resolved["schema"] is main._CLASSIFY_JSON_SCHEMA


def test_client_satisfies_the_surface_main_uses(server):
    """``main._count_tokens``/``_truncate_to_tokens`` probe for these by name
    and silently skip the token budget when they are missing — which would
    make a too-long prompt a 500 from llama-server instead of a truncation."""

    client = server({})

    for attr in ("tokenize", "detokenize", "create_chat_completion"):
        assert callable(getattr(client, attr, None)), attr
