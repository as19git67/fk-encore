"""/classify constrains the completion with a JSON *schema*, not just
"any JSON object".

`{"type": "json_object"}` alone permits `{}`, which is the shortest satisfying
string and therefore the cheapest escape for a model that would rather emit
something the grammar forbids. Measured on a 7697-document run: ~200 first
attempts came back empty and 66 still were on the retry, dead-ending in the
sonstiges fallback with confidence 0.

The schema makes the five no-default fields of ClassifyResponse mandatory. The
risk it introduces is the opposite one — llama.cpp builds its object rule from
`properties`, so an optional field missing from the schema becomes *unemittable*
and its facet silently stops working. Hence the drift guard below.
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


class _CapturingLlm:
    def __init__(self) -> None:
        self.kwargs: dict = {}

    def create_chat_completion(self, **kwargs):
        self.kwargs = kwargs
        return {"choices": [{"message": {"content": json.dumps(_GOOD)}}]}


def _classify(llm, body) -> tuple[int, dict]:
    main._state["llm"] = llm
    try:
        client = TestClient(main.app)
        resp = client.post("/classify", json=body)
        return resp.status_code, resp.json()
    finally:
        main._state["llm"] = None


def test_every_response_field_is_emittable():
    """Drift guard: a field on ClassifyResponse that is absent from the schema
    cannot be generated at all, because llama.cpp derives the permitted object
    keys from `properties`. Adding a field to the model without adding it here
    would silently disable it."""

    in_schema = set(main._CLASSIFY_JSON_SCHEMA["properties"])
    on_model = set(main.ClassifyResponse.model_fields)
    assert in_schema == on_model, (
        "schema properties and ClassifyResponse fields diverged: "
        f"only in schema={sorted(in_schema - on_model)}, "
        f"only on model={sorted(on_model - in_schema)}"
    )


def test_exactly_the_no_default_fields_are_required():
    """`required` must match the fields pydantic has no default for — those are
    precisely the ones whose absence makes a payload degenerate."""

    required = set(main._CLASSIFY_JSON_SCHEMA["required"])
    assert required == set(main._CLASSIFY_CORE_FIELDS)

    no_default = {
        name for name, f in main.ClassifyResponse.model_fields.items() if f.is_required()
    }
    assert required == no_default, (
        f"required={sorted(required)} but pydantic's no-default fields are {sorted(no_default)}"
    )


def test_optional_fields_are_not_required():
    """The facets must stay optional — forcing them would make the model invent
    a document_type or tax_year for every document, which the whitelist and the
    dump-all backstop then have to undo."""

    required = set(main._CLASSIFY_JSON_SCHEMA["required"])
    for optional in (
        "doc_date",
        "sender",
        "document_number",
        "document_type",
        "document_type_confidence",
        "tax_relevant",
        "tax_year",
        "tax_year_confidence",
        "tax_sections",
    ):
        assert optional in main._CLASSIFY_JSON_SCHEMA["properties"], optional
        assert optional not in required, optional


def test_nullable_fields_accept_null_in_the_schema():
    """doc_date/sender/document_number/document_type/tax_year are `X | None` on
    the model; a string-only schema would forbid the null the model must be able
    to return when it finds no date or sender."""

    props = main._CLASSIFY_JSON_SCHEMA["properties"]
    for field in ("doc_date", "sender", "document_number", "document_type", "tax_year"):
        assert "null" in props[field]["type"], field


def test_schema_is_passed_to_the_completion_call():
    llm = _CapturingLlm()
    status, _ = _classify(llm, {"text": "doc", "taxonomy": [{"slug": "x", "name": "X"}]})
    assert status == 200
    rf = llm.kwargs["response_format"]
    assert rf["type"] == "json_object"
    assert rf["schema"] is main._CLASSIFY_JSON_SCHEMA


def test_startup_resolution_can_degrade_to_plain_json_object():
    """When the binding's converter rejects the schema, /classify must keep
    working on the plain json_object format rather than raising on every call —
    a 500 here is read as "service unavailable" by the app and defers the
    document for an unbounded retry."""

    llm = _CapturingLlm()
    main._state["classify_response_format"] = {"type": "json_object"}
    try:
        status, _ = _classify(llm, {"text": "doc", "taxonomy": [{"slug": "x", "name": "X"}]})
    finally:
        main._state["classify_response_format"] = None
    assert status == 200
    assert llm.kwargs["response_format"] == {"type": "json_object"}


def test_unresolved_startup_state_still_uses_the_schema():
    """Tests and any path that bypasses the lifespan leave the resolved format
    unset; that must fall back to the schema, not to no constraint at all."""

    assert main._state.get("classify_response_format") is None
    llm = _CapturingLlm()
    _classify(llm, {"text": "doc", "taxonomy": [{"slug": "x", "name": "X"}]})
    assert llm.kwargs["response_format"] is main._CLASSIFY_RESPONSE_FORMAT


def test_tax_sections_items_require_slug_and_confidence():
    """The nested objects need their own `required`, otherwise the model can
    emit `{}` entries inside the array — the same empty-output failure one
    level down."""

    items = main._CLASSIFY_JSON_SCHEMA["properties"]["tax_sections"]["items"]
    assert set(items["required"]) == {"slug", "confidence"}
    assert set(items["properties"]) == set(main.TaxAssignment.model_fields)


def test_schema_is_json_serialisable():
    """llama.cpp receives this as JSON; a stray Python object would only surface
    at inference time on the real binding."""

    assert json.loads(json.dumps(main._CLASSIFY_JSON_SCHEMA)) == main._CLASSIFY_JSON_SCHEMA
