"""``/json-prompt``: the schema reaches the model, and an answer cut off at
``max_tokens`` is a 422 the caller does not retry, not a 502 it defers."""

from __future__ import annotations

import os
import sys
from typing import Any

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402


class _FakeLlm:
    def __init__(self, content: str, finish_reason: str = "stop") -> None:
        self.content = content
        self.finish_reason = finish_reason
        self.calls: list[dict[str, Any]] = []

    def create_chat_completion(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {"choices": [{"message": {"content": self.content}, "finish_reason": self.finish_reason}]}


def _post(llm: _FakeLlm, body: dict[str, Any]):
    main._state["llm"] = llm
    try:
        return TestClient(main.app).post("/json-prompt", json=body)
    finally:
        main._state["llm"] = None


def test_returns_the_object():
    res = _post(_FakeLlm('{"values": []}'), {"prompt": "x"})
    assert res.status_code == 200
    assert res.json() == {"values": []}


def test_without_schema_only_json_mode():
    llm = _FakeLlm("{}")
    _post(llm, {"prompt": "x"})
    assert llm.calls[0]["response_format"] == {"type": "json_object"}


def test_passes_the_schema_on():
    llm = _FakeLlm("{}")
    schema = {"type": "object", "properties": {"quote": {"type": "string", "maxLength": 160}}}
    _post(llm, {"prompt": "x", "schema": schema})
    assert llm.calls[0]["response_format"] == {"type": "json_object", "schema": schema}


def test_answer_cut_off_at_the_token_cap_is_422():
    looped = '{"values": [{"field": "betrag", "printed": "1,00", "quote": "Summe:' + "\\n|" * 50
    res = _post(_FakeLlm(looped, finish_reason="length"), {"prompt": "x", "max_tokens": 100})
    assert res.status_code == 422
    assert "max_tokens=100" in res.json()["detail"]


def test_other_invalid_json_stays_502():
    res = _post(_FakeLlm("not json"), {"prompt": "x"})
    assert res.status_code == 502
