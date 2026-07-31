"""A schema-mismatch /classify response must be 422, not 502.

Background: documents/llm-client.ts treats any >=500 status as "LLM service
temporarily unavailable" and defers the scan-worker job for an unbounded
retry (no attempt cap — see scan-queue.ts deferJob). A pydantic validation
failure on the LLM's own output (e.g. a confidence the schema doesn't allow)
is not a transient outage — it reflects a real fact about the document that
will keep recurring on every retry. Misclassifying it as 502 caused an
infinite reclassify loop instead of surfacing a visible failure. See main.py
around the ClassifyResponse(**data) coercion.

The flip side is that a 422 fails the document *hard* (status='failed'), so
only a genuinely broken payload may reach it. An implausible value in a
single optional derived field is sanitized before the coercion instead — see
test_classify_tax_year_sanity.py.
"""

from __future__ import annotations

import json
import os
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402


class _ScriptedLlm:
    def __init__(self, payload: dict) -> None:
        self.payload = payload

    def create_chat_completion(self, **_kwargs):
        return {"choices": [{"message": {"content": json.dumps(self.payload)}}]}


_BASE_FIELDS = {
    "category_slug": "finanzen-wertpapiere",
    "title": "Jahresdepotauszug",
    "summary": "s",
    "tags": [],
    "confidence": 0.9,
}


def test_schema_mismatch_is_422_not_502():
    # A confidence outside 0..1 triggers a pydantic ValidationError inside the
    # /classify handler's final coercion step. Unlike the optional derived
    # facets, `confidence` is a required core field with no sanitizing step.
    llm = _ScriptedLlm({**_BASE_FIELDS, "confidence": 42.0})
    main._state["llm"] = llm
    try:
        client = TestClient(main.app)
        resp = client.post(
            "/classify",
            json={
                "text": "doc",
                "taxonomy": [{"slug": "finanzen-wertpapiere", "name": "X"}],
                "tax_sections": [{"slug": "anlage-kap", "name": "Anlage KAP", "group": "einkuenfte"}],
            },
        )
        assert resp.status_code == 422, resp.text
        assert "schema mismatch" in resp.json()["detail"]
    finally:
        main._state["llm"] = None


def test_historical_tax_year_no_longer_triggers_schema_mismatch():
    # The regression case from production: a 1997 Jahresdepotauszug used to
    # 502 (and loop forever); it must now classify successfully.
    llm = _ScriptedLlm({**_BASE_FIELDS, "tax_year": 1997, "tax_relevant": True})
    main._state["llm"] = llm
    try:
        client = TestClient(main.app)
        resp = client.post(
            "/classify",
            json={
                "text": "doc",
                "taxonomy": [{"slug": "finanzen-wertpapiere", "name": "X"}],
                "tax_sections": [{"slug": "anlage-kap", "name": "Anlage KAP", "group": "einkuenfte"}],
            },
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["tax_year"] == 1997
    finally:
        main._state["llm"] = None
