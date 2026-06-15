"""Tests for the configurable document char-cap on /classify.

``CLASSIFY_TEXT_CHAR_LIMIT`` is a cheap pre-cap applied before the n_ctx
token-budget guard. The fake Llama below has no ``tokenize`` method, so the
token guard is skipped and the char-cap is the only limiter — which is exactly
what we want to assert here.
"""

from __future__ import annotations

import os
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402


class _CapturingLlm:
    """Records the user prompt; no tokenize() so the token guard is skipped."""

    def __init__(self) -> None:
        self.captured: dict[str, object] = {}

    def create_chat_completion(self, **kwargs: object) -> dict:
        self.captured["messages"] = kwargs["messages"]
        return {
            "choices": [
                {
                    "message": {
                        "content": '{"category_slug":"finanzen","title":"t",'
                        '"summary":"s","tags":[],"confidence":0.5}'
                    }
                }
            ]
        }


def _post_long_text(limit: int, body_len: int) -> str:
    """Run /classify with a CLASSIFY_TEXT_CHAR_LIMIT of *limit* and a document
    of *body_len* 'A's; return the user prompt the LLM saw."""
    orig_limit = main.CLASSIFY_TEXT_CHAR_LIMIT
    main.CLASSIFY_TEXT_CHAR_LIMIT = limit
    llm = _CapturingLlm()
    main._state["llm"] = llm
    try:
        client = TestClient(main.app)
        resp = client.post(
            "/classify",
            json={
                "text": "A" * body_len,
                "taxonomy": [{"slug": "finanzen", "name": "Finanzen"}],
            },
        )
        assert resp.status_code == 200, resp.text
        return llm.captured["messages"][1]["content"]
    finally:
        main._state["llm"] = None
        main.CLASSIFY_TEXT_CHAR_LIMIT = orig_limit


def test_text_is_truncated_to_the_char_limit():
    prompt = _post_long_text(limit=10, body_len=100)
    # Exactly the first 10 characters of the document survive.
    assert "A" * 10 in prompt
    assert "A" * 11 not in prompt


def test_raising_the_limit_keeps_more_text():
    prompt = _post_long_text(limit=50, body_len=100)
    assert "A" * 50 in prompt
    assert "A" * 51 not in prompt
