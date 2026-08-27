"""`/vision/transcribe` — the narrow contract the OCR resolver depends on.

The endpoint exists to answer one question about a crop of a page: which
characters are printed here. Everything asserted below is a property that, if
it broke, would turn the resolver from a safety mechanism into a source of
silently rewritten numbers.
"""

from __future__ import annotations

import base64
import json
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

import main

# 1x1 PNG. Content is irrelevant — the LLM is stubbed; what matters is that the
# endpoint packages it as an image content part.
PIXEL_B64 = base64.b64encode(
    bytes.fromhex(
        "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
        "1f15c4890000000a49444154789c6300010000050001".replace(" ", "")
    )
).decode("ascii")


class _RecordingLlm:
    """Captures the call and returns a fixed transcription."""

    def __init__(self, payload: object = None) -> None:
        self.calls: list[dict] = []
        self.payload = payload if payload is not None else {"text": "23 AUG 02", "confidence": 0.94}

    def create_chat_completion(self, **kwargs):
        self.calls.append(kwargs)
        content = self.payload if isinstance(self.payload, str) else json.dumps(self.payload)
        return {"choices": [{"message": {"content": content}}]}


def _with_mmproj(path: str) -> None:
    """LlmConfig is frozen, so swap in a replaced copy rather than mutating."""
    main._state["config"] = replace(main._state["config"], mmproj_path=path)


@pytest.fixture
def vision_llm():
    """A loaded model *with* a projector — the configuration this needs."""
    llm = _RecordingLlm()
    original = main._state["config"]
    main._state["llm"] = llm
    _with_mmproj("/models/mmproj-test.gguf")
    yield llm
    main._state["llm"] = None
    main._state["config"] = original


def _post(body: dict) -> "object":
    return TestClient(main.app).post("/vision/transcribe", json=body)


def test_transcribes_a_crop(vision_llm):
    res = _post({"image_b64": PIXEL_B64, "hint": "23 aus oz", "expected_type": "date"})
    assert res.status_code == 200
    assert res.json()["text"] == "23 AUG 02"
    assert res.json()["confidence"] == 0.94


def test_sends_the_image_as_an_image_part(vision_llm):
    # If the crop were pasted into the text prompt instead, the model would be
    # guessing from the OCR hint alone — which is the exact failure the whole
    # design exists to avoid, and it would still return plausible answers.
    _post({"image_b64": PIXEL_B64})
    content = vision_llm.calls[0]["messages"][1]["content"]
    parts = [p["type"] for p in content]
    assert "image_url" in parts
    assert content[0]["image_url"]["url"].startswith("data:image/png;base64,")


def test_decodes_greedily(vision_llm):
    # A transcription has one right answer. Sampling a second-choice character
    # is precisely the failure mode.
    _post({"image_b64": PIXEL_B64})
    assert vision_llm.calls[0]["temperature"] == 0.0


def test_prompt_forbids_inventing_characters(vision_llm):
    _post({"image_b64": PIXEL_B64, "hint": "7.500"})
    system = vision_llm.calls[0]["messages"][0]["content"]
    assert "invent" in system.lower()
    assert "?" in system


def test_hint_is_offered_as_unreliable(vision_llm):
    # The hint must never read as "here is the answer, confirm it".
    _post({"image_b64": PIXEL_B64, "hint": "23 aus oz"})
    text = vision_llm.calls[0]["messages"][1]["content"][1]["text"]
    assert "23 aus oz" in text
    assert "unreliable" in text.lower()


def test_expected_type_does_not_authorise_a_guess(vision_llm):
    _post({"image_b64": PIXEL_B64, "expected_type": "amount"})
    text = vision_llm.calls[0]["messages"][1]["content"][1]["text"]
    assert "transcribe what is printed even if it is not" in text.lower()


def test_rejects_an_unknown_expected_type(vision_llm):
    assert _post({"image_b64": PIXEL_B64, "expected_type": "kennzeichen"}).status_code == 400


def test_without_a_projector_it_says_so():
    # The confusing state: weights loaded, text prompts working, images not.
    # A generic model error here costs an afternoon of diagnosis.
    original = main._state["config"]
    main._state["llm"] = _RecordingLlm()
    _with_mmproj("")
    try:
        res = _post({"image_b64": PIXEL_B64})
        assert res.status_code == 503
        assert "mmproj" in res.json()["detail"].lower()
    finally:
        main._state["llm"] = None
        main._state["config"] = original


def test_non_json_completion_is_a_502_not_a_transcription(vision_llm):
    vision_llm.payload = "I can see a date in this image!"
    assert _post({"image_b64": PIXEL_B64}).status_code == 502


def test_confidence_is_clamped(vision_llm):
    vision_llm.payload = {"text": "x", "confidence": 7.5}
    assert _post({"image_b64": PIXEL_B64}).json()["confidence"] == 1.0
