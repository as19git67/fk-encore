"""Test that taxonomy/doctype/tax hints are shed before returning 413.

When the taxonomy + hints overflow the context window, the classifier
drops hints (keeping slug + name only) as a second fallback after
shedding few-shot examples. This prevents a 413 when the taxonomy grows.

Uses the same sentinel-tokenizer approach as test_classify_examples_budget.
"""

from __future__ import annotations

import os
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402


class _SentinelLlm:
    """Counts ``ZZZ`` occurrences as tokens and records the prompt it saw."""

    def __init__(self) -> None:
        self.captured: dict[str, object] = {}

    def tokenize(self, b: bytes, add_bos: bool = False, special: bool = False) -> list[int]:
        return [0] * b.decode("utf-8", "ignore").count("ZZZ")

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


# The hint contributes 30 ZZZ tokens; without it only the name's 10.
_HINT_TEXT = "ZZZ" * 30


def _request_with_hints() -> dict:
    return {
        "text": "hello",
        "taxonomy": [
            {"slug": "finanzen", "name": "ZZZ" * 10, "hint": _HINT_TEXT},
        ],
    }


def _patch_budget(monkeypatch_ctx: int) -> tuple[int, int, int]:
    orig = (main.LLM_CTX, main._CLASSIFY_MAX_TOKENS, main._CLASSIFY_TEMPLATE_HEADROOM)
    main.LLM_CTX = monkeypatch_ctx
    main._CLASSIFY_MAX_TOKENS = 0
    main._CLASSIFY_TEMPLATE_HEADROOM = 0
    return orig


def _restore_budget(orig: tuple[int, int, int]) -> None:
    main.LLM_CTX, main._CLASSIFY_MAX_TOKENS, main._CLASSIFY_TEMPLATE_HEADROOM = orig


def test_hints_are_shed_instead_of_413_when_prompt_overflows():
    # With hints: overhead = 40 ZZZ tokens (10 name + 30 hint).
    # budget 50: 50 - 40 = 10 < 64 → would be 413 with hints.
    # Without hints: overhead = 10 ZZZ tokens → 50 - 10 = 40 ... still < 64.
    # So we need budget big enough that hint-free overhead fits.
    # budget 80: with hints overhead=40 → 80-40=40 < 64 → shed hints;
    # without hints overhead=10 → 80-10=70 >= 64 → proceed.
    orig = _patch_budget(80)
    llm = _SentinelLlm()
    main._state["llm"] = llm
    try:
        client = TestClient(main.app)
        resp = client.post("/classify", json=_request_with_hints())
        assert resp.status_code == 200, resp.text
        assert resp.json()["category_slug"] == "finanzen"
        user_msg = llm.captured["messages"][1]["content"]
        # The hint text was stripped from the prompt.
        assert _HINT_TEXT not in user_msg
        # But the category name is still there.
        assert "finanzen" in user_msg
    finally:
        main._state["llm"] = None
        _restore_budget(orig)


def test_hints_are_kept_when_they_fit():
    # Generous budget: hints comfortably fit and must be rendered.
    orig = _patch_budget(1000)
    llm = _SentinelLlm()
    main._state["llm"] = llm
    try:
        client = TestClient(main.app)
        resp = client.post("/classify", json=_request_with_hints())
        assert resp.status_code == 200, resp.text
        user_msg = llm.captured["messages"][1]["content"]
        assert _HINT_TEXT in user_msg
    finally:
        main._state["llm"] = None
        _restore_budget(orig)
