"""Regression test for the few-shot context-budget guard.

Few-shot examples are orientation only and must never be the reason a
classification fails. Before the fix, adding the examples block tipped the
prompt past ``n_ctx`` for households with a large taxonomy, so ``/classify``
returned 413 for almost every document. The guard now sheds the examples and
classifies the document anyway.

The token accounting is driven by a fake Llama whose ``tokenize`` counts a
sentinel substring (``ZZZ``), so the test controls the overhead precisely
without depending on the real tokenizer or model.
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


def _request_with_examples() -> dict:
    return {
        "text": "hello",  # zero sentinel tokens → no truncation
        "taxonomy": [{"slug": "finanzen", "name": "ZZZ" * 70}],  # 70 overhead tokens
        "examples": [
            {
                "category_slug": "finanzen-gehalt",
                "category_name": "Gehalt",
                "title": "ZZZ" * 10,  # 10 overhead tokens when examples kept
                "sender": "Acme",
            }
        ],
    }


_EXAMPLES_HEADER = "Ähnliche, bereits eingeordnete Dokumente"


def _patch_budget(monkeypatch_ctx: int) -> tuple[int, int, int]:
    """Pin the budget math so ``budget == monkeypatch_ctx``. Returns the
    originals for restoration."""
    orig = (main.LLM_CTX, main._CLASSIFY_MAX_TOKENS, main._CLASSIFY_TEMPLATE_HEADROOM)
    main.LLM_CTX = monkeypatch_ctx
    main._CLASSIFY_MAX_TOKENS = 0
    main._CLASSIFY_TEMPLATE_HEADROOM = 0
    return orig


def _restore_budget(orig: tuple[int, int, int]) -> None:
    main.LLM_CTX, main._CLASSIFY_MAX_TOKENS, main._CLASSIFY_TEMPLATE_HEADROOM = orig


def test_examples_are_shed_instead_of_413_when_prompt_overflows():
    # budget 140: with examples overhead=80 → 140-80=60 < 64 → shed;
    # without examples overhead=70 → 140-70=70 >= 64 → classify proceeds.
    orig = _patch_budget(140)
    llm = _SentinelLlm()
    main._state["llm"] = llm
    try:
        client = TestClient(main.app)
        resp = client.post("/classify", json=_request_with_examples())
        assert resp.status_code == 200, resp.text
        assert resp.json()["category_slug"] == "finanzen"
        user_msg = llm.captured["messages"][1]["content"]
        # The examples block was dropped, but the document was still classified.
        assert _EXAMPLES_HEADER not in user_msg
    finally:
        main._state["llm"] = None
        _restore_budget(orig)


def test_examples_are_kept_when_they_fit():
    # Generous budget: examples comfortably fit and must be rendered.
    orig = _patch_budget(1000)
    llm = _SentinelLlm()
    main._state["llm"] = llm
    try:
        client = TestClient(main.app)
        resp = client.post("/classify", json=_request_with_examples())
        assert resp.status_code == 200, resp.text
        user_msg = llm.captured["messages"][1]["content"]
        assert _EXAMPLES_HEADER in user_msg
    finally:
        main._state["llm"] = None
        _restore_budget(orig)
