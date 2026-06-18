"""Tests for the dump-all tax_sections backstop on /classify.

Small classifiers occasionally return the entire offered tax-section list at
high confidence when no real match exists. We drop the entire tax assignment
in that case so the user's tax view stays clean.
"""

from __future__ import annotations

import json
import os
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402


class _ScriptedLlm:
    """Returns whatever JSON payload the test plants in `next_payload`."""

    def __init__(self) -> None:
        self.next_payload: dict | None = None

    def create_chat_completion(self, **_kwargs):
        return {
            "choices": [
                {"message": {"content": json.dumps(self.next_payload)}}
            ]
        }


def _classify(payload: dict, n_sections: int) -> dict:
    llm = _ScriptedLlm()
    llm.next_payload = payload
    main._state["llm"] = llm
    try:
        client = TestClient(main.app)
        tax_sections = [
            {"slug": f"sec-{i}", "name": f"Sec {i}", "group": "abzuege"}
            for i in range(n_sections)
        ]
        resp = client.post(
            "/classify",
            json={
                "text": "doc",
                "taxonomy": [{"slug": "x", "name": "X"}],
                "tax_sections": tax_sections,
            },
        )
        assert resp.status_code == 200, resp.text
        return resp.json()
    finally:
        main._state["llm"] = None


_BASE_FIELDS = {
    "category_slug": "x",
    "title": "t",
    "summary": "s",
    "tags": [],
    "confidence": 0.9,
    "tax_relevant": True,
    "tax_year": 2024,
    "tax_year_confidence": 0.9,
}


def test_normal_payload_keeps_tax_sections():
    payload = {
        **_BASE_FIELDS,
        "tax_sections": [
            {"slug": "sec-0", "confidence": 0.9},
            {"slug": "sec-1", "confidence": 0.7},
        ],
    }
    result = _classify(payload, n_sections=18)
    assert result["tax_relevant"] is True
    assert len(result["tax_sections"]) == 2
    assert result["tax_year"] == 2024


def test_dump_all_payload_is_dropped():
    # LLM returns every offered section — clear dump-all signal.
    payload = {
        **_BASE_FIELDS,
        "tax_sections": [{"slug": f"sec-{i}", "confidence": 0.99} for i in range(18)],
    }
    result = _classify(payload, n_sections=18)
    assert result["tax_sections"] == []
    assert result["tax_relevant"] is False
    assert result["tax_year"] is None
    assert result["tax_year_confidence"] == 0.0


def test_at_threshold_is_kept():
    # Exactly TAX_SECTIONS_MAX (4) sections — still legitimate.
    payload = {
        **_BASE_FIELDS,
        "tax_sections": [{"slug": f"sec-{i}", "confidence": 0.8} for i in range(4)],
    }
    result = _classify(payload, n_sections=18)
    assert len(result["tax_sections"]) == 4
    assert result["tax_relevant"] is True


def test_just_above_threshold_is_dropped():
    payload = {
        **_BASE_FIELDS,
        "tax_sections": [{"slug": f"sec-{i}", "confidence": 0.8} for i in range(5)],
    }
    result = _classify(payload, n_sections=18)
    assert result["tax_sections"] == []
    assert result["tax_relevant"] is False


def test_backstop_can_be_disabled():
    orig = main.TAX_SECTIONS_MAX
    main.TAX_SECTIONS_MAX = 0
    try:
        payload = {
            **_BASE_FIELDS,
            "tax_sections": [
                {"slug": f"sec-{i}", "confidence": 0.99} for i in range(18)
            ],
        }
        result = _classify(payload, n_sections=18)
        assert len(result["tax_sections"]) == 18
        assert result["tax_relevant"] is True
    finally:
        main.TAX_SECTIONS_MAX = orig
