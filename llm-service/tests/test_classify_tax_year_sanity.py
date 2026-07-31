"""An implausible tax_year is dropped, not fatal.

Production case: a scanned doctor's invoice dated 12.03.2019 whose patient
birth year (1955) came back as `tax_year`. The value fell below the schema's
lower bound, so the final ClassifyResponse coercion raised — surfacing as a
422, which documents/llm-client.ts turns into a hard failure that parks the
document in status='failed' with a red banner. The rest of the classification
(category, title, doc_date, sender, sections) was perfectly good.

The year is one optional derived field: an implausible one must be dropped,
with the rest of the classification kept. See `_sane_tax_year` in main.py.
"""

from __future__ import annotations

import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402


class _ScriptedLlm:
    def __init__(self, payload: dict) -> None:
        self.payload = payload

    def create_chat_completion(self, **_kwargs):
        return {"choices": [{"message": {"content": json.dumps(self.payload)}}]}


_BASE_FIELDS = {
    "category_slug": "arztrechnungen",
    "title": "Rechnung von Dr. med. Peter Baumgartner",
    "doc_date": "2019-03-12",
    "sender": "Dr. med. Peter Baumgartner",
    "document_number": "6613",
    "summary": "Arztrechnung über 20,11 EUR.",
    "tags": [],
    "confidence": 0.9,
}

_REQUEST = {
    "text": "Rechnung 12.03.19 ... geb. 17.11.1955",
    "taxonomy": [{"slug": "arztrechnungen", "name": "Arztrechnungen"}],
    "tax_sections": [
        {"slug": "anlage-vorsorgeaufwand", "name": "Anlage Vorsorgeaufwand", "group": "abzuege"},
    ],
}


def _classify(payload: dict):
    main._state["llm"] = _ScriptedLlm(payload)
    try:
        return TestClient(main.app).post("/classify", json=_REQUEST)
    finally:
        main._state["llm"] = None


@pytest.mark.parametrize("bad_year", [1955, 42, 20191, "keine", -5])
def test_implausible_tax_year_is_dropped_not_fatal(bad_year):
    resp = _classify({
        **_BASE_FIELDS,
        "tax_relevant": True,
        "tax_year": bad_year,
        "tax_year_confidence": 0.8,
        "tax_sections": [{"slug": "anlage-vorsorgeaufwand", "confidence": 0.7}],
    })

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["tax_year"] is None
    assert body["tax_year_confidence"] == 0.0
    # Everything the classifier got right survives.
    assert body["category_slug"] == "arztrechnungen"
    assert body["doc_date"] == "2019-03-12"
    assert body["document_number"] == "6613"
    assert body["tax_sections"] == [{"slug": "anlage-vorsorgeaufwand", "confidence": 0.7}]


def test_plausible_tax_year_is_kept():
    resp = _classify({
        **_BASE_FIELDS,
        "tax_relevant": True,
        "tax_year": 2019,
        "tax_year_confidence": 0.8,
        "tax_sections": [{"slug": "anlage-vorsorgeaufwand", "confidence": 0.7}],
    })

    assert resp.status_code == 200, resp.text
    assert resp.json()["tax_year"] == 2019
    assert resp.json()["tax_year_confidence"] == pytest.approx(0.8)


def test_missing_tax_year_stays_none():
    resp = _classify({**_BASE_FIELDS, "tax_relevant": False})

    assert resp.status_code == 200, resp.text
    assert resp.json()["tax_year"] is None
