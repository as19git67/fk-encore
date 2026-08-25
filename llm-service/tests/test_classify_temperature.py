"""The first /classify attempt decodes greedily.

Classification is a labelling task with one right answer, not open-ended
generation, so sampling only picks between candidates the model already ranks.
It cost more than it bought.

Two production failures traced back to it. `sender` and `doc_date` were written
straight through from the classifier's answer, so a run that happened to stay
quiet about a field erased what an earlier run had extracted — re-classifying
the whole corpus did that to a sizeable share of it. And the model scoreboard
could not be read: the difference between two runs was partly sampling noise
rather than the change under test, so no hint or taxonomy edit could be
credited or ruled out.

Greedy decoding does not make a wrong answer right. It makes a wrong answer
consistent, which is the difference between a fixable taxonomy problem and
unfixable noise.

The retry is the deliberate exception: it exists for a degenerate generation,
which reproduces exactly on a second greedy call with the same prompt, so it
must change the sampling to be worth making at all.
"""

from __future__ import annotations

import json
import os
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402

_GOOD = {
    "category_slug": "finanzen-wertpapiere",
    "title": "Jahresdepotauszug",
    "summary": "s",
    "tags": [],
    "confidence": 0.9,
}

_REQUEST_BODY = {
    "text": "doc",
    "taxonomy": [{"slug": "finanzen-wertpapiere", "name": "X"}],
}


class _TemperatureRecordingLlm:
    """Records the temperature of every call; optionally fails the first."""

    def __init__(self, degenerate_first: bool = False) -> None:
        self.temperatures: list[float] = []
        self.degenerate_first = degenerate_first

    def create_chat_completion(self, **kwargs):
        self.temperatures.append(kwargs["temperature"])
        payload = {} if (self.degenerate_first and len(self.temperatures) == 1) else _GOOD
        return {"choices": [{"message": {"content": json.dumps(payload)}}]}


def _classify(llm) -> int:
    main._state["llm"] = llm
    try:
        return TestClient(main.app).post("/classify", json=_REQUEST_BODY).status_code
    finally:
        main._state["llm"] = None


def test_first_attempt_is_greedy():
    llm = _TemperatureRecordingLlm()
    assert _classify(llm) == 200
    assert llm.temperatures == [0.0]


def test_temperature_is_sent_rather_than_omitted():
    # 0.0 is falsy. A backend that tests the value for truthiness rather than
    # for None would silently drop it and sample at its own default, which
    # would look exactly like the bug this replaces.
    llm = _TemperatureRecordingLlm()
    _classify(llm)
    assert llm.temperatures[0] is not None
    assert isinstance(llm.temperatures[0], float)


def test_retry_changes_the_sampling():
    # Without this the retry is pointless: a greedy call with the same prompt
    # returns the same degenerate completion.
    llm = _TemperatureRecordingLlm(degenerate_first=True)
    assert _classify(llm) == 200
    assert len(llm.temperatures) == 2
    assert llm.temperatures[0] == 0.0
    assert llm.temperatures[1] > llm.temperatures[0]
