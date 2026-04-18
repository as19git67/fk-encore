"""Pydantic schema validation — no model load required."""

from __future__ import annotations

import os
import sys

import pytest
from pydantic import ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from main import (  # noqa: E402
    ClassifyRequest,
    ClassifyResponse,
    EmbedRequest,
    EmbedResponse,
    TaxonomyNode,
)


class TestEmbedRequest:
    def test_single_text(self):
        req = EmbedRequest(texts=["hallo"])
        assert req.texts == ["hallo"]

    def test_multiple_texts(self):
        req = EmbedRequest(texts=["a", "b", "c"])
        assert len(req.texts) == 3

    def test_empty_list_rejected(self):
        with pytest.raises(ValidationError):
            EmbedRequest(texts=[])

    def test_missing_texts_rejected(self):
        with pytest.raises(ValidationError):
            EmbedRequest()


class TestEmbedResponse:
    def test_roundtrip(self):
        r = EmbedResponse(embeddings=[[0.1, 0.2], [0.3, 0.4]], dim=2)
        assert r.dim == 2
        assert r.embeddings[0] == [0.1, 0.2]


class TestTaxonomyNode:
    def test_root_node(self):
        n = TaxonomyNode(slug="finanzen", name="Finanzen")
        assert n.parent_slug is None

    def test_child_node(self):
        n = TaxonomyNode(slug="rechnungen", name="Rechnungen", parent_slug="finanzen")
        assert n.parent_slug == "finanzen"


class TestClassifyRequest:
    def test_minimal(self):
        req = ClassifyRequest(
            text="Stromrechnung",
            taxonomy=[TaxonomyNode(slug="finanzen", name="Finanzen")],
        )
        assert req.locale == "de"
        assert req.max_tags == 6

    def test_empty_text_rejected(self):
        with pytest.raises(ValidationError):
            ClassifyRequest(
                text="",
                taxonomy=[TaxonomyNode(slug="finanzen", name="Finanzen")],
            )

    def test_empty_taxonomy_rejected(self):
        with pytest.raises(ValidationError):
            ClassifyRequest(text="x", taxonomy=[])


class TestClassifyResponse:
    def test_minimal(self):
        r = ClassifyResponse(
            category_slug="finanzen",
            title="Stromrechnung 03/2026",
            summary="Monatsabrechnung Strom.",
            tags=["strom", "rechnung"],
            confidence=0.87,
        )
        assert r.doc_date is None
        assert r.sender is None

    def test_confidence_range(self):
        with pytest.raises(ValidationError):
            ClassifyResponse(
                category_slug="x",
                title="t",
                summary="s",
                tags=[],
                confidence=1.5,
            )
        with pytest.raises(ValidationError):
            ClassifyResponse(
                category_slug="x",
                title="t",
                summary="s",
                tags=[],
                confidence=-0.1,
            )
