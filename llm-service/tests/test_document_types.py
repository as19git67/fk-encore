"""Tests for the document-type facet plumbing in the /classify handler.

Covers the pydantic schemas (``DocumentTypeEntry``, the new ``document_type``
fields on ``ClassifyRequest``/``ClassifyResponse``) and the rendering of the
document-type outline that is spliced into the user prompt.
"""

from __future__ import annotations

import os
import sys

import pytest
from pydantic import ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from main import (  # noqa: E402
    ClassifyRequest,
    ClassifyResponse,
    DocumentTypeEntry,
    TaxonomyNode,
    _document_types_outline,
)


class TestDocumentTypeEntry:
    def test_with_hint(self):
        e = DocumentTypeEntry(slug="rechnung", name="Rechnung / Mahnung", hint="Zahlungsaufforderung.")
        assert e.hint is not None

    def test_without_hint(self):
        e = DocumentTypeEntry(slug="rechnung", name="Rechnung / Mahnung")
        assert e.hint is None


class TestClassifyRequestDocumentTypes:
    def test_default_empty(self):
        req = ClassifyRequest(
            text="x",
            taxonomy=[TaxonomyNode(slug="finanzen", name="Finanzen")],
        )
        assert req.document_types == []

    def test_supplied(self):
        req = ClassifyRequest(
            text="x",
            taxonomy=[TaxonomyNode(slug="finanzen", name="Finanzen")],
            document_types=[
                DocumentTypeEntry(slug="rechnung", name="Rechnung / Mahnung"),
                DocumentTypeEntry(slug="bescheid", name="Bescheid / Festsetzung"),
            ],
        )
        assert len(req.document_types) == 2
        assert req.document_types[0].slug == "rechnung"


class TestClassifyResponseDocumentType:
    def _base_kwargs(self) -> dict:
        return dict(
            category_slug="finanzen",
            title="t",
            summary="s",
            tags=[],
            confidence=0.9,
        )

    def test_defaults(self):
        r = ClassifyResponse(**self._base_kwargs())
        assert r.document_type is None
        assert r.document_type_confidence == 0.0

    def test_full_payload(self):
        r = ClassifyResponse(
            **self._base_kwargs(),
            document_type="rechnung",
            document_type_confidence=0.82,
        )
        assert r.document_type == "rechnung"
        assert r.document_type_confidence == 0.82

    def test_confidence_range(self):
        with pytest.raises(ValidationError):
            ClassifyResponse(**self._base_kwargs(), document_type_confidence=1.5)
        with pytest.raises(ValidationError):
            ClassifyResponse(**self._base_kwargs(), document_type_confidence=-0.1)


class TestDocumentTypesOutline:
    def test_empty_input_yields_empty_string(self):
        assert _document_types_outline([]) == ""

    def test_renders_slug_name_and_hint(self):
        entries = [
            DocumentTypeEntry(slug="rechnung", name="Rechnung / Mahnung", hint="Zahlungsaufforderung."),
        ]
        out = _document_types_outline(entries)
        assert "rechnung: Rechnung / Mahnung" in out
        assert "Zahlungsaufforderung" in out

    def test_renders_without_hint(self):
        entries = [DocumentTypeEntry(slug="beleg", name="Beleg / Quittung")]
        out = _document_types_outline(entries)
        assert out == "- beleg: Beleg / Quittung"

    def test_one_line_per_entry(self):
        entries = [
            DocumentTypeEntry(slug="rechnung", name="Rechnung"),
            DocumentTypeEntry(slug="bescheid", name="Bescheid"),
            DocumentTypeEntry(slug="vertrag", name="Vertrag"),
        ]
        out = _document_types_outline(entries)
        assert len(out.splitlines()) == 3
