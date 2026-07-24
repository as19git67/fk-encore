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
    "taxonomy": [{"slug": "finanzen-wertpapiere", "name": "X"}],
}


def _classify(llm) -> "tuple[int, dict]":
    main._state["llm"] = llm
    try:
        client = TestClient(main.app)
        resp = client.post("/classify", json=_REQUEST_BODY)
        return resp.status_code, resp.json()
    finally:
        main._state["llm"] = None


def test_degenerate_first_attempt_retries_and_succeeds():
    llm = _SequencedLlm([_DEGENERATE, _GOOD])
    status, body = _classify(llm)
    assert status == 200, body
    assert body["category_slug"] == "finanzen-wertpapiere"
    assert llm.calls == 2


def test_degenerate_on_every_attempt_still_fails_after_the_cap():
    llm = _SequencedLlm([_DEGENERATE, _DEGENERATE, _DEGENERATE])
    status, body = _classify(llm)
    assert status == 422, body
    assert "schema mismatch" in body["detail"]
    # Bounded — exactly the attempt cap, not one call per queue-level retry.
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


def test_constraint_violation_on_a_fully_populated_payload_does_not_retry():
    # confidence=1.5 is out of range but every core field IS present (so
    # _has_core_fields is true) — this must fail on the FIRST attempt, no
    # retry, since it reflects a real (bad) value rather than an empty sample.
    bad_confidence = {**_GOOD, "confidence": 1.5}
    llm = _SequencedLlm([bad_confidence, _GOOD])
    status, body = _classify(llm)
    assert status == 422, body
    assert llm.calls == 1
