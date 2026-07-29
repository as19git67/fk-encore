"""Bounded in-process retry on /classify for a single degenerate generation.

Production regression: a completion that returned valid JSON but omitted
every field without a default (category_slug/title/summary/tags/confidence)
— in under 500ms, i.e. a one-off degenerate sample, not a real attempt — used
to fail the whole /classify call immediately with 422 (the fix from the
tax_year-range incident: schema-mismatches don't get retried because they're
usually deterministic). That over-corrected for THIS class of failure, which
is a sampling fluke, not a fact about the document. /classify now retries
once in-process before giving up. A value that DID parse the core fields but
fails a constraint (e.g. an out-of-range tax_year) must NOT retry — it is
deterministic and would just fail identically again.
"""

from __future__ import annotations

import json
import os
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402


class _SequencedLlm:
    """Returns each payload in `payloads` in order, one per call."""

    def __init__(self, payloads: list[dict]) -> None:
        self.payloads = payloads
        self.calls = 0

    def create_chat_completion(self, **_kwargs):
        payload = self.payloads[min(self.calls, len(self.payloads) - 1)]
        self.calls += 1
        return {"choices": [{"message": {"content": json.dumps(payload)}}]}


_GOOD = {
    "category_slug": "finanzen-wertpapiere",
    "title": "Jahresdepotauszug",
    "summary": "s",
    "tags": [],
    "confidence": 0.9,
}

# The production case: valid JSON, but none of the fields without a default
# are present at all.
_DEGENERATE: dict = {}

_REQUEST_BODY = {
    "text": "doc",
    # No 'sonstiges' node → the degenerate fallback can't fire, so these
    # requests exercise the hard-failure path.
    "taxonomy": [{"slug": "finanzen-wertpapiere", "name": "X"}],
}

# Same, but WITH the catch-all node the app always sends in production, so the
# degenerate fallback can synthesise a low-confidence "sonstiges" result.
_REQUEST_WITH_FALLBACK = {
    "text": "doc",
    "taxonomy": [
        {"slug": "finanzen-wertpapiere", "name": "X"},
        {"slug": "sonstiges", "name": "Sonstiges"},
    ],
}


def _classify(llm, body=_REQUEST_BODY) -> "tuple[int, dict]":
    main._state["llm"] = llm
    try:
        client = TestClient(main.app)
        resp = client.post("/classify", json=body)
        return resp.status_code, resp.json()
    finally:
        main._state["llm"] = None


def test_degenerate_first_attempt_retries_and_succeeds():
    llm = _SequencedLlm([_DEGENERATE, _GOOD])
    status, body = _classify(llm)
    assert status == 200, body
    assert body["category_slug"] == "finanzen-wertpapiere"
    assert llm.calls == 2


def test_degenerate_persists_then_falls_back_to_sonstiges():
    # Production case: the model reproducibly returns `{}` for a document. With
    # the catch-all offered, the service must not dead-end — it returns a
    # low-confidence sonstiges result so the doc stays usable and reviewable.
    llm = _SequencedLlm([_DEGENERATE, _DEGENERATE, _DEGENERATE])
    status, body = _classify(llm, _REQUEST_WITH_FALLBACK)
    assert status == 200, body
    assert body["category_slug"] == "sonstiges"
    assert body["confidence"] == 0.0
    assert body["title"] == ""
    # Bounded — exactly the attempt cap, not one call per queue-level retry.
    assert llm.calls == 2


def test_degenerate_without_fallback_category_fails_hard():
    # No 'sonstiges' offered → nothing safe to fall back to → hard 422 (never
    # 502, which the caller would defer for an unbounded retry).
    llm = _SequencedLlm([_DEGENERATE, _DEGENERATE, _DEGENERATE])
    status, body = _classify(llm)
    assert status == 422, body
    assert "fallback category" in body["detail"]
    assert llm.calls == 2


def test_non_json_first_attempt_retries_and_succeeds():
    class _RawThenJsonLlm:
        def __init__(self) -> None:
            self.calls = 0

        def create_chat_completion(self, **_kwargs):
            self.calls += 1
            content = "not json at all" if self.calls == 1 else json.dumps(_GOOD)
            return {"choices": [{"message": {"content": content}}]}

    llm = _RawThenJsonLlm()
    status, body = _classify(llm)
    assert status == 200, body
    assert llm.calls == 2


def test_persistent_non_json_falls_back_to_sonstiges_not_502():
    class _AlwaysRawLlm:
        def __init__(self) -> None:
            self.calls = 0

        def create_chat_completion(self, **_kwargs):
            self.calls += 1
            return {"choices": [{"message": {"content": "still not json"}}]}

    llm = _AlwaysRawLlm()
    status, body = _classify(llm, _REQUEST_WITH_FALLBACK)
    # Crucially NOT 502 — that would make the caller defer for an unbounded retry.
    assert status == 200, body
    assert body["category_slug"] == "sonstiges"
    assert llm.calls == 2


def test_retry_with_few_shot_examples_sheds_them_without_crashing():
    # Regression: the retry re-assembles the prompt without the few-shot
    # examples, but `_assemble` grew a second (with_hints) parameter when hint
    # shedding was added — the call site still passed one argument, so a retry
    # on a request that carried examples raised TypeError *outside* the
    # try/except and surfaced as an uncaught 500 instead of retrying.
    # Only reachable with DOCUMENTS_FEWSHOT_ENABLED=true, hence unnoticed.
    body = {
        **_REQUEST_BODY,
        "examples": [
            {
                "sender": "Musterbank",
                "title": "Jahresdepotauszug 2023",
                "category_slug": "finanzen-wertpapiere",
                "category_name": "Wertpapiere",
            }
        ],
    }
    llm = _SequencedLlm([_DEGENERATE, _GOOD])
    status, resp = _classify(llm, body)
    assert status == 200, resp
    assert resp["category_slug"] == "finanzen-wertpapiere"
    assert llm.calls == 2


def test_constraint_violation_on_a_fully_populated_payload_does_not_retry():
    # confidence=1.5 is out of range but every core field IS present (so
    # _has_core_fields is true) — this must fail on the FIRST attempt, no
    # retry and no sonstiges fallback, since it reflects a real (bad) value
    # rather than an empty sample. Masking it would hide genuine schema bugs.
    bad_confidence = {**_GOOD, "confidence": 1.5}
    llm = _SequencedLlm([bad_confidence, _GOOD])
    status, body = _classify(llm, _REQUEST_WITH_FALLBACK)
    assert status == 422, body
    assert "schema mismatch" in body["detail"]
    assert llm.calls == 1
