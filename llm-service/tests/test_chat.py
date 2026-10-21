"""Tests for ``POST /chat``: request validation, the inproc tool emulation,
the server path's reply checks, and both streaming routes.

No model is loaded. A fake stands in for ``_state["llm"]`` — one shaped like
``llama_cpp.Llama`` for the inproc path, one shaped like
``LlamaServerClient`` (it has ``stream_chat_completion``) for the server path.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

import chat
import main
from llama_server import LlamaServerError

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_photos",
            "description": "Photos filtered by favorite flag and date range.",
            "parameters": {
                "type": "object",
                "properties": {
                    "favorite": {"type": "boolean"},
                    "dateFrom": {"type": "string"},
                    "dateTo": {"type": "string"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_album",
            "description": "Propose a new album.",
            "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
        },
    },
]

QUESTION = {"role": "user", "content": "Mach mir ein Album mit allen favorisierten Bildern von 2025."}


class FakeInproc:
    """The slice of ``llama_cpp.Llama`` that the emulation calls."""

    def __init__(self, replies: list[str]) -> None:
        self.replies = list(replies)
        self.calls: list[dict[str, Any]] = []

    def create_chat_completion(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {
            "choices": [{"message": {"role": "assistant", "content": self.replies.pop(0)}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        }


class FakeServer:
    """The slice of ``LlamaServerClient`` that /chat calls."""

    def __init__(self, message: dict[str, Any] | None = None, error: Exception | None = None,
                 chunks: list[str] | None = None) -> None:
        self.message = message
        self.error = error
        self.chunks = chunks or []
        self.payloads: list[dict[str, Any]] = []

    def chat_completion(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.payloads.append(payload)
        if self.error:
            raise self.error
        return {"choices": [{"message": self.message, "finish_reason": "stop"}], "usage": {"total_tokens": 3}}

    def stream_chat_completion(self, payload: dict[str, Any], should_stop=lambda: False):
        self.payloads.append(payload)
        for c in self.chunks:
            yield c
        if self.error:
            raise self.error


@pytest.fixture
def use_llm():
    def install(llm: Any) -> TestClient:
        main._state["llm"] = llm
        return TestClient(main.app)

    yield install
    main._state["llm"] = None


def _sse_payloads(text: str) -> list[str]:
    return [line[len("data: "):] for line in text.splitlines() if line.startswith("data: ")]


# ─── validation ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "body, fragment",
    [
        ({"messages": []}, "messages"),
        ({"messages": [{"role": "tool", "content": "x"}]}, "tool_call_id"),
        ({"messages": [QUESTION, {"role": "tool", "tool_call_id": "nope", "content": "x"}]}, "unknown call"),
        ({"messages": [QUESTION, {"role": "assistant", "content": "hi"}]}, "must not end"),
        ({"messages": [{"role": "user", "content": ""}]}, "needs content"),
        ({"messages": [QUESTION], "tools": [TOOLS[0], TOOLS[0]]}, "unique"),
        ({"messages": [QUESTION], "tools": TOOLS, "tool_choice": "sometimes"}, "tool_choice"),
        ({"messages": [QUESTION], "tools": TOOLS,
          "tool_choice": {"type": "function", "function": {"name": "delete_everything"}}}, "unknown tool"),
        ({"messages": [QUESTION], "tool_choice": "required"}, "needs tools"),
        ({"messages": [QUESTION, {"role": "assistant", "tool_calls": [
            {"id": "c1", "function": {"name": "list_photos", "arguments": "{not json"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": "[]"}], "tools": TOOLS}, "not valid JSON"),
        ({"messages": [QUESTION], "tools": [{"type": "function", "function": {"name": "has space"}}]}, "invalid tool name"),
        ({"messages": [QUESTION], "max_tokens": 0}, "max_tokens"),
    ],
)
def test_rejects_malformed_requests(use_llm, body, fragment):
    client = use_llm(FakeInproc([]))
    resp = client.post("/chat", json=body)
    assert resp.status_code == 422
    assert fragment in json.dumps(resp.json())


def test_503_while_no_model_is_loaded():
    main._state["llm"] = None
    resp = TestClient(main.app).post("/chat", json={"messages": [QUESTION]})
    assert resp.status_code == 503


# ─── inproc emulation ──────────────────────────────────────────────────────────


def test_inproc_returns_a_tool_call_in_the_server_shape(use_llm):
    llm = FakeInproc(['{"tool": "list_photos", "arguments": {"favorite": true, "dateFrom": "2025-01-01"}}'])
    client = use_llm(llm)

    resp = client.post("/chat", json={"messages": [QUESTION], "tools": TOOLS})

    assert resp.status_code == 200
    body = resp.json()
    assert body["backend"] == "inproc"
    assert body["finish_reason"] == "tool_calls"
    message = body["message"]
    assert message["content"] is None
    [call] = message["tool_calls"]
    assert call["type"] == "function" and call["id"].startswith("call_")
    assert call["function"]["name"] == "list_photos"
    assert json.loads(call["function"]["arguments"]) == {"favorite": True, "dateFrom": "2025-01-01"}

    sent = llm.calls[0]
    # The tools went into the system prompt, the choice into the grammar.
    assert sent["messages"][0]["role"] == "system"
    assert "list_photos" in sent["messages"][0]["content"]
    schema = sent["response_format"]["schema"]
    assert schema["anyOf"][0]["properties"]["tool"]["enum"] == ["list_photos", "create_album"]


def test_inproc_follow_up_with_tool_result_returns_an_answer(use_llm):
    llm = FakeInproc(['{"answer": "Ich habe 143 favorisierte Fotos aus 2025 gefunden."}'])
    client = use_llm(llm)
    history = [
        {"role": "system", "content": "Today is 2026-10-15."},
        QUESTION,
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "list_photos", "arguments": '{"favorite": true}'}}]},
        {"role": "tool", "tool_call_id": "c1", "content": '{"total": 143}'},
    ]

    resp = client.post("/chat", json={"messages": history, "tools": TOOLS})

    assert resp.status_code == 200
    body = resp.json()
    assert body["finish_reason"] == "stop"
    assert body["message"] == {"role": "assistant", "content": "Ich habe 143 favorisierte Fotos aus 2025 gefunden."}

    flat = llm.calls[0]["messages"]
    assert [m["role"] for m in flat] == ["system", "user", "assistant", "user"]
    assert "Today is 2026-10-15." in flat[0]["content"]
    assert json.loads(flat[2]["content"]) == {"tool": "list_photos", "arguments": {"favorite": True}}
    assert flat[3]["content"].startswith("Result of list_photos")


@pytest.mark.parametrize(
    "choice, expect_keys",
    [
        ("none", {"answer"}),
        ("required", {"tool", "arguments"}),
        ({"type": "function", "function": {"name": "create_album"}}, {"tool", "arguments"}),
    ],
)
def test_inproc_tool_choice_narrows_the_grammar(choice, expect_keys):
    req = chat.ChatRequest(messages=[QUESTION], tools=TOOLS, tool_choice=choice)
    schema = chat.emulation_response_format(req)["schema"]
    assert set(schema["required"]) == expect_keys
    if isinstance(choice, dict):
        assert schema["properties"]["tool"]["enum"] == ["create_album"]


def test_inproc_without_tools_is_plain_chat(use_llm):
    llm = FakeInproc(["Hallo!"])
    client = use_llm(llm)

    body = client.post("/chat", json={"messages": [{"role": "user", "content": "Hallo"}]}).json()

    assert body["message"] == {"role": "assistant", "content": "Hallo!"}
    assert "response_format" not in llm.calls[0]


@pytest.mark.parametrize(
    "raw",
    ['{"tool": "drop_tables", "arguments": {}}', '{"tool": "list_photos", "arguments": [1]}', "{}", "not json"],
)
def test_inproc_unusable_turn_is_502(use_llm, raw):
    client = use_llm(FakeInproc([raw]))
    resp = client.post("/chat", json={"messages": [QUESTION], "tools": TOOLS})
    assert resp.status_code == 502


def test_inproc_stream_keeps_the_chunk_format(use_llm):
    client = use_llm(FakeInproc(['{"tool": "create_album", "arguments": {"name": "Favoriten 2025"}}']))

    resp = client.post("/chat", json={"messages": [QUESTION], "tools": TOOLS, "stream": True})

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    payloads = _sse_payloads(resp.text)
    assert payloads[-1] == "[DONE]"
    first, last = json.loads(payloads[0]), json.loads(payloads[1])
    call = first["choices"][0]["delta"]["tool_calls"][0]
    assert call["index"] == 0 and call["function"]["name"] == "create_album"
    assert last["choices"][0]["finish_reason"] == "tool_calls"
    # The fake's own usage, and the window it ran in.
    assert json.loads(payloads[2])["context"] == {"n_ctx": main.LLM_CTX, "prompt_tokens": 10, "completion_tokens": 5}


# ─── server backend ────────────────────────────────────────────────────────────


def test_server_tool_call_is_checked_and_passed_on(use_llm):
    llm = FakeServer(message={
        "role": "assistant",
        "content": "",
        "tool_calls": [
            {"id": "a", "type": "function", "function": {"name": "list_photos", "arguments": '{"favorite":true}'}},
            {"id": "b", "type": "function", "function": {"name": "create_album", "arguments": {"name": "X"}}},
        ],
    })
    client = use_llm(llm)

    resp = client.post("/chat", json={"messages": [QUESTION], "tools": TOOLS, "tool_choice": "auto"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["backend"] == "server"
    assert body["finish_reason"] == "tool_calls"
    assert body["message"]["content"] is None
    assert [c["id"] for c in body["message"]["tool_calls"]] == ["a", "b"]
    assert json.loads(body["message"]["tool_calls"][1]["function"]["arguments"]) == {"name": "X"}

    payload = llm.payloads[0]
    assert payload["tools"][0]["function"]["name"] == "list_photos"
    assert payload["tool_choice"] == "auto"
    assert payload["chat_template_kwargs"] == {"enable_thinking": False}


def test_server_passes_tool_history_through_in_openai_shape(use_llm):
    llm = FakeServer(message={"role": "assistant", "content": "143 Fotos."})
    client = use_llm(llm)
    history = [
        QUESTION,
        {"role": "assistant", "tool_calls": [
            {"id": "c1", "function": {"name": "list_photos", "arguments": {"favorite": True}}}]},
        {"role": "tool", "tool_call_id": "c1", "content": '{"total": 143}'},
    ]

    body = client.post("/chat", json={"messages": history, "tools": TOOLS}).json()

    assert body["message"]["content"] == "143 Fotos."
    sent = llm.payloads[0]["messages"]
    assert sent[1]["tool_calls"][0]["function"]["arguments"] == '{"favorite": true}'
    assert sent[2] == {"role": "tool", "content": '{"total": 143}', "tool_call_id": "c1"}


@pytest.mark.parametrize(
    "message",
    [
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "x", "function": {"name": "rm_rf", "arguments": "{}"}}]},
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "x", "function": {"name": "list_photos", "arguments": "{oops"}}]},
        {"role": "assistant", "content": "   "},
    ],
)
def test_server_unusable_reply_is_502(use_llm, message):
    client = use_llm(FakeServer(message=message))
    resp = client.post("/chat", json={"messages": [QUESTION], "tools": TOOLS})
    assert resp.status_code == 502


def test_server_context_overflow_is_413(use_llm):
    err = LlamaServerError("POST /v1/chat/completions -> HTTP 400: the request exceeds the available context size")
    client = use_llm(FakeServer(error=err))
    resp = client.post("/chat", json={"messages": [QUESTION], "tools": TOOLS})
    assert resp.status_code == 413


def test_server_stream_relays_chunks(use_llm):
    chunks = [
        '{"choices":[{"delta":{"role":"assistant","content":"Ich "}}]}',
        '{"choices":[{"delta":{"content":"suche."}}]}',
    ]
    client = use_llm(FakeServer(chunks=chunks))

    resp = client.post("/chat", json={"messages": [QUESTION], "stream": True})

    assert resp.status_code == 200
    payloads = _sse_payloads(resp.text)
    assert payloads[:-2] == chunks and payloads[-1] == "[DONE]"
    # Nothing counted the tokens; the window is still named.
    assert json.loads(payloads[-2]) == {"context": {"n_ctx": main.LLM_CTX, "prompt_tokens": None, "completion_tokens": None}}


def test_server_stream_reports_the_context_used(use_llm):
    chunks = [
        '{"choices":[{"delta":{"content":"Fertig."}}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}],"timings":{"prompt_n":200,"cache_n":1000,"predicted_n":7}}',
        '{"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":8,"total_tokens":1208}}',
    ]
    llm = FakeServer(chunks=chunks)
    client = use_llm(llm)
    main._state["server_n_ctx"] = 30000
    try:
        resp = client.post("/chat", json={"messages": [QUESTION], "stream": True})
    finally:
        main._state["server_n_ctx"] = None

    payloads = _sse_payloads(resp.text)
    assert json.loads(payloads[-2]) == {"context": {"n_ctx": 30000, "prompt_tokens": 1200, "completion_tokens": 8}}
    assert llm.payloads[0]["stream_options"] == {"include_usage": True}


def test_stream_usage_falls_back_to_timings():
    body = '{"choices":[],"timings":{"prompt_n":12,"cache_n":30,"predicted_n":4}}'
    assert chat.stream_usage(body) == {"prompt_tokens": 42, "completion_tokens": 4}
    assert chat.stream_usage('{"choices":[{"delta":{"content":"x"}}]}') is None


def test_server_stream_failure_becomes_an_error_event(use_llm):
    client = use_llm(FakeServer(chunks=['{"choices":[]}'], error=LlamaServerError("boom")))

    resp = client.post("/chat", json={"messages": [QUESTION], "stream": True})

    payloads = _sse_payloads(resp.text)
    assert payloads[-1] == "[DONE]"
    error = json.loads(payloads[-2])["error"]
    assert error["status"] == 502 and "boom" in error["message"]


def test_stream_releases_the_inference_slot(use_llm):
    client = use_llm(FakeServer(chunks=['{"choices":[]}']))
    for _ in range(3):
        assert client.post("/chat", json={"messages": [QUESTION], "stream": True}).status_code == 200
    # A leaked permit would make the next non-streamed turn wait and 503.
    client = use_llm(FakeServer(message={"role": "assistant", "content": "ok"}))
    assert client.post("/chat", json={"messages": [QUESTION]}).status_code == 200
