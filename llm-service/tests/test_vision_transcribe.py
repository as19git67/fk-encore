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
    """LlmConfig is frozen, so swap in a replaced copy rather than mutating.

    `backend="server"` is part of the precondition, not decoration: a projector
    is only ever handed to llama-server, so `resolve_mmproj` reports none for
    the in-process runtime however the path is set. Saying so here keeps the
    fixture honest about what the endpoints actually require.
    """
    main._state["config"] = replace(
        main._state["config"], mmproj_path=path, backend="server",
    )


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


# ─── /vision/fields ──────────────────────────────────────────────────────────
#
# The other vision call: the characters read fine, the *pairing* of labels to
# values did not. Answering that needs the whole page, which is why the
# guardrails here are about scope and honesty rather than about transcription.


def _post_fields(body: dict) -> "object":
    return TestClient(main.app).post("/vision/fields", json=body)


def test_assigns_the_requested_labels(vision_llm):
    vision_llm.payload = {"fields": [{"label": "Rechnungsdatum", "value": "23.08.2002"}]}
    res = _post_fields({"image_b64": PIXEL_B64, "labels": ["Rechnungsdatum"]})
    assert res.status_code == 200
    assert res.json()["fields"] == [{"label": "Rechnungsdatum", "value": "23.08.2002"}]


def test_sends_the_page_as_an_image_part(vision_llm):
    _post_fields({"image_b64": PIXEL_B64, "labels": ["Betrag"]})
    content = vision_llm.calls[0]["messages"][1]["content"]
    assert content[0]["type"] == "image_url"
    assert "Betrag" in content[1]["text"]


def test_prompt_forbids_inventing_a_value(vision_llm):
    # The whole reason a page may be handed over: the model reassigns what is
    # printed, it does not contribute content. The caller checks this too, by
    # locating every value in the OCR text — belt and braces, deliberately.
    _post_fields({"image_b64": PIXEL_B64, "labels": ["Betrag"]})
    system = vision_llm.calls[0]["messages"][0]["content"]
    assert "invent" in system.lower()
    assert "omit" in system.lower()


def test_drops_labels_nobody_asked_about(vision_llm):
    # A model that starts reporting the whole page is off task; keeping only
    # what was asked stops that from reaching the caller at all.
    vision_llm.payload = {
        "fields": [
            {"label": "Rechnungsdatum", "value": "23.08.2002"},
            {"label": "Geburtsdatum", "value": "01.01.1970"},
        ]
    }
    res = _post_fields({"image_b64": PIXEL_B64, "labels": ["Rechnungsdatum"]})
    assert [f["label"] for f in res.json()["fields"]] == ["Rechnungsdatum"]


def test_drops_an_empty_value(vision_llm):
    vision_llm.payload = {"fields": [{"label": "Betrag", "value": "   "}]}
    assert _post_fields({"image_b64": PIXEL_B64, "labels": ["Betrag"]}).json()["fields"] == []


def test_decodes_greedily_here_too(vision_llm):
    _post_fields({"image_b64": PIXEL_B64, "labels": ["Betrag"]})
    assert vision_llm.calls[0]["temperature"] == 0.0


def test_rejects_an_empty_label_list(vision_llm):
    assert _post_fields({"image_b64": PIXEL_B64, "labels": ["  "]}).status_code == 400


def test_caps_how_many_labels_may_be_asked(vision_llm):
    res = _post_fields({"image_b64": PIXEL_B64, "labels": [f"L{i}" for i in range(50)]})
    assert res.status_code == 400


def test_fields_without_a_projector_says_so():
    original = main._state["config"]
    main._state["llm"] = _RecordingLlm()
    _with_mmproj("")
    try:
        res = _post_fields({"image_b64": PIXEL_B64, "labels": ["Betrag"]})
        assert res.status_code == 503
        assert "mmproj" in res.json()["detail"].lower()
    finally:
        main._state["llm"] = None
        main._state["config"] = original


def test_fields_non_json_is_a_502(vision_llm):
    vision_llm.payload = "The document shows several fields."
    assert _post_fields({"image_b64": PIXEL_B64, "labels": ["Betrag"]}).status_code == 502


def test_inproc_backend_reports_no_projector():
    """A projector on disk is not vision the in-process runtime can offer.

    llama-cpp-python has no per-family image chat handler in the pinned CPU
    build, so answering anything but 503 here would promise a capability no
    request can use — and the promise would only break at the model call.
    """
    original = main._state["config"]
    main._state["llm"] = _RecordingLlm()
    main._state["config"] = replace(
        original, mmproj_path="/models/mmproj-test.gguf", backend="inproc",
    )
    try:
        res = _post({"image_b64": PIXEL_B64})
        assert res.status_code == 503
        assert "mmproj" in res.json()["detail"].lower()
    finally:
        main._state["llm"] = None
        main._state["config"] = original


# ─── /vision/letterhead ──────────────────────────────────────────────────────
#
# The third vision call, and the one that needs no label. A German business
# letter names neither its date nor its sender: both are identified by where
# they sit on the page, which is exactly what the text pipeline discards.


def _post_letterhead(body: dict) -> "object":
    return TestClient(main.app).post("/vision/letterhead", json=body)


def test_reports_the_two_unlabelled_fields(vision_llm):
    vision_llm.payload = {"date": "24.04.2023", "sender": "Muster Bauspar AG"}
    res = _post_letterhead({"image_b64": PIXEL_B64})
    assert res.status_code == 200
    assert res.json()["date"] == "24.04.2023"
    assert res.json()["sender"] == "Muster Bauspar AG"


def test_asks_without_naming_a_label(vision_llm):
    # The distinguishing property. /vision/fields is handed labels to look up;
    # here there is nothing to look up, so the instruction must describe the
    # two fields by where they sit and what they are not.
    _post_letterhead({"image_b64": PIXEL_B64})
    content = vision_llm.calls[0]["messages"][1]["content"]
    assert content[0]["type"] == "image_url"
    instruction = content[1]["text"].lower()
    assert "salutation" in instruction
    assert "addressee" in instruction


def test_a_missing_field_comes_back_as_null(vision_llm):
    vision_llm.payload = {"date": None, "sender": "Muster Bauspar AG"}
    assert _post_letterhead({"image_b64": PIXEL_B64}).json()["date"] is None


def test_a_model_that_says_null_in_words_means_null(vision_llm):
    # A small model reports "not visible" as readily with a word as with a JSON
    # null. Storing the word would put the string "none" in the date column.
    vision_llm.payload = {"date": "none", "sender": "  "}
    body = _post_letterhead({"image_b64": PIXEL_B64}).json()
    assert body["date"] is None
    assert body["sender"] is None


def test_prompt_forbids_inferring_a_value(vision_llm):
    # The caller anchors every answer in the page's own OCR words, but the
    # model should not be trying in the first place.
    _post_letterhead({"image_b64": PIXEL_B64})
    system = vision_llm.calls[0]["messages"][0]["content"].lower()
    assert "never infer" in system


def test_reports_the_caption_the_date_came_from(vision_llm):
    # Evidence, not decoration: an unlabelled date is the document dating
    # itself, a labelled one has to be weighed against what that caption means
    # on this kind of document.
    vision_llm.payload = {
        "date": "2014-11-17",
        "date_label": "Lieferdatum",
        "sender": "Muster GmbH",
        "language": "de",
    }
    assert _post_letterhead({"image_b64": PIXEL_B64}).json()["date_label"] == "Lieferdatum"


def test_an_unlabelled_date_reports_no_caption(vision_llm):
    vision_llm.payload = {"date": "24.04.2023", "date_label": None, "sender": None}
    assert _post_letterhead({"image_b64": PIXEL_B64}).json()["date_label"] is None


def test_a_caption_answered_as_a_sentence_is_not_a_caption(vision_llm):
    # A caption is a caption. Anything longer is the model explaining itself,
    # and storing it would put prose in the evidence field.
    vision_llm.payload = {
        "date": "24.04.2023",
        "date_label": "The date printed at the top right of the letterhead block",
        "sender": None,
    }
    assert _post_letterhead({"image_b64": PIXEL_B64}).json()["date_label"] is None


def test_keeps_the_captions_that_actually_occur(vision_llm):
    # The bound has to admit the real ones: one long German compound, and a
    # short English phrase of three words.
    for caption in ("Rechnungsdatum", "Date of issue", "Datum der Leistungserbringung"):
        vision_llm.payload = {"date": "24.04.2023", "date_label": caption, "sender": None}
        assert _post_letterhead({"image_b64": PIXEL_B64}).json()["date_label"] == caption


def test_asks_about_a_document_not_a_letter(vision_llm):
    # "The date the sender put on this letter" is the wrong question for a
    # delivery note, which answered it correctly with null while printing
    # "Lieferdatum" twice.
    _post_letterhead({"image_b64": PIXEL_B64})
    instruction = vision_llm.calls[0]["messages"][1]["content"][1]["text"].lower()
    assert "delivery note" in instruction
    assert "invoice" in instruction


def test_asks_about_a_page_not_the_first_one(vision_llm):
    # The same instruction is sent for the last page, where a contract is dated
    # beside its signature. A prompt certain it is looking at page 1 describes
    # a page the model is not being shown.
    _post_letterhead({"image_b64": PIXEL_B64})
    instruction = vision_llm.calls[0]["messages"][1]["content"][1]["text"].lower()
    assert "a page from a document" in instruction
    assert "signature" in instruction
    assert "first page of a document" not in instruction


def test_separates_never_from_last_resort(vision_llm):
    # The exclusions are not equally absolute. A due date belongs to something
    # else and is never the answer; a franking date is merely a poor one, and
    # on a document printing nothing better it beats an empty field.
    _post_letterhead({"image_b64": PIXEL_B64})
    instruction = vision_llm.calls[0]["messages"][1]["content"][1]["text"]
    assert "NEVER report" in instruction
    assert "LAST RESORT" in instruction
    assert "franking" in instruction.lower()


def test_reports_the_document_language(vision_llm):
    # Used to break a tie when a numeric date's order is not settled by the
    # document's own numbers.
    vision_llm.payload = {"date": "24.04.2023", "sender": "Muster AG", "language": "de"}
    assert _post_letterhead({"image_b64": PIXEL_B64}).json()["language"] == "de"


def test_a_language_answered_as_prose_is_not_a_language(vision_llm):
    # A code, not a description. "German business letter" is the model
    # answering a different question, and storing it would feed nonsense into
    # the date-convention decision.
    vision_llm.payload = {
        "date": None,
        "sender": None,
        "language": "This letter is written in German",
    }
    assert _post_letterhead({"image_b64": PIXEL_B64}).json()["language"] is None


def test_language_is_normalised_to_a_short_code(vision_llm):
    vision_llm.payload = {"date": None, "sender": None, "language": "DE-de"}
    assert _post_letterhead({"image_b64": PIXEL_B64}).json()["language"] == "de-de"


def test_an_older_model_answer_without_a_language_still_works(vision_llm):
    vision_llm.payload = {"date": "24.04.2023", "sender": "Muster AG"}
    body = _post_letterhead({"image_b64": PIXEL_B64}).json()
    assert body["language"] is None
    assert body["date"] == "24.04.2023"


def test_asks_for_the_language_of_the_prose_not_the_sender(vision_llm):
    # The distinction the Apple case turns on: a letter can be written in one
    # language and dated in another's convention.
    _post_letterhead({"image_b64": PIXEL_B64})
    instruction = vision_llm.calls[0]["messages"][1]["content"][1]["text"].lower()
    assert "language" in instruction
    assert "639-1" in instruction


def test_letterhead_decodes_greedily(vision_llm):
    _post_letterhead({"image_b64": PIXEL_B64})
    assert vision_llm.calls[0]["temperature"] == 0.0


def test_letterhead_non_json_is_a_502(vision_llm):
    vision_llm.payload = "The letter is from a building society."
    assert _post_letterhead({"image_b64": PIXEL_B64}).status_code == 502


def test_letterhead_without_a_projector_says_so():
    original = main._state["config"]
    main._state["llm"] = _RecordingLlm()
    main._state["config"] = replace(original, mmproj_path="", backend="server")
    try:
        res = _post_letterhead({"image_b64": PIXEL_B64})
        assert res.status_code == 503
        assert "mmproj" in res.json()["detail"].lower()
    finally:
        main._state["llm"] = None
        main._state["config"] = original


def test_prompts_can_be_replaced_without_rebuilding_the_image(vision_llm):
    # The service image takes ~55 minutes to build, so a prompt compiled into
    # it cannot be iterated on — which is why the classify prompts already live
    # in the app. Wording is most of what decides whether this endpoint answers
    # well, so it gets the same treatment.
    original = dict(main._VISION_PROMPTS)
    try:
        TestClient(main.app).put(
            "/prompts",
            json={
                "classify_system": "s",
                "classify_document_type": "d",
                "classify_tax": "t",
                "classify_subject_persons": "p",
                "classify_examples": "e",
                "letterhead_instruction": "Report the date and the sender.",
            },
        )
        _post_letterhead({"image_b64": PIXEL_B64})
        content = vision_llm.calls[0]["messages"][1]["content"]
        assert content[1]["text"] == "Report the date and the sender."
        # The part that was not pushed keeps its compiled-in default.
        assert main._VISION_PROMPTS["letterhead_system"] == original["letterhead_system"]
    finally:
        main._VISION_PROMPTS.clear()
        main._VISION_PROMPTS.update(original)
