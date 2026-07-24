"""Tests for tax-return detection plumbing in the /classify handler.

Covers the pydantic schemas (``TaxSectionEntry``, ``TaxAssignment``, the new
fields on ``ClassifyRequest``/``ClassifyResponse``) and the rendering of the
tax-section outline that is spliced into the user prompt.
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
    TaxAssignment,
    TaxSectionEntry,
    TaxonomyNode,
    _tax_sections_outline,
)


class TestTaxSectionEntry:
    def test_with_hint(self):
        e = TaxSectionEntry(
            slug="anlage-n",
            name="Anlage N — Nichtselbstständige Arbeit",
            group="einkuenfte",
            hint="Lohnsteuerbescheinigung, Gehaltsabrechnungen.",
        )
        assert e.hint is not None

    def test_without_hint(self):
        e = TaxSectionEntry(slug="x", name="X", group="einkuenfte")
        assert e.hint is None


class TestTaxAssignment:
    def test_valid(self):
        a = TaxAssignment(slug="anlage-n", confidence=0.73)
        assert a.confidence == 0.73

    def test_confidence_out_of_range(self):
        with pytest.raises(ValidationError):
            TaxAssignment(slug="anlage-n", confidence=1.2)
        with pytest.raises(ValidationError):
            TaxAssignment(slug="anlage-n", confidence=-0.1)


class TestClassifyRequestTax:
    def test_tax_sections_default_empty(self):
        req = ClassifyRequest(
            text="x",
            taxonomy=[TaxonomyNode(slug="finanzen", name="Finanzen")],
        )
        assert req.tax_sections == []

    def test_tax_sections_supplied(self):
        req = ClassifyRequest(
            text="x",
            taxonomy=[TaxonomyNode(slug="finanzen", name="Finanzen")],
            tax_sections=[
                TaxSectionEntry(slug="anlage-n", name="Anlage N", group="einkuenfte"),
            ],
        )
        assert len(req.tax_sections) == 1
        assert req.tax_sections[0].slug == "anlage-n"


class TestClassifyResponseTax:
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
        assert r.tax_relevant is False
        assert r.tax_year is None
        assert r.tax_year_confidence == 0.0
        assert r.tax_sections == []

    def test_full_tax_payload(self):
        r = ClassifyResponse(
            **self._base_kwargs(),
            tax_relevant=True,
            tax_year=2025,
            tax_year_confidence=0.88,
            tax_sections=[
                TaxAssignment(slug="anlage-n", confidence=0.91),
                TaxAssignment(slug="werbungskosten-n", confidence=0.64),
            ],
        )
        assert r.tax_relevant is True
        assert r.tax_year == 2025
        assert len(r.tax_sections) == 2

    def test_tax_year_out_of_range(self):
        with pytest.raises(ValidationError):
            ClassifyResponse(**self._base_kwargs(), tax_year=42)
        with pytest.raises(ValidationError):
            ClassifyResponse(**self._base_kwargs(), tax_year=3000)
        with pytest.raises(ValidationError):
            ClassifyResponse(**self._base_kwargs(), tax_year=1969)

    def test_tax_year_accepts_historical_years_down_to_1970(self):
        # A 1997 Jahresdepotauszug is a real, unremarkable household document —
        # the lower bound must not reject it (see main.py ClassifyResponse).
        r = ClassifyResponse(**self._base_kwargs(), tax_year=1997)
        assert r.tax_year == 1997
        r2 = ClassifyResponse(**self._base_kwargs(), tax_year=1970)
        assert r2.tax_year == 1970

    def test_tax_year_confidence_range(self):
        with pytest.raises(ValidationError):
            ClassifyResponse(**self._base_kwargs(), tax_year_confidence=1.5)


class TestTaxSectionsOutline:
    def test_empty_input_yields_empty_string(self):
        assert _tax_sections_outline([]) == ""

    def test_groups_in_fixed_order(self):
        entries = [
            TaxSectionEntry(slug="aussergewoehnliche", name="Außergewöhnliche", group="abzuege"),
            TaxSectionEntry(slug="steuerbescheid", name="Steuerbescheid", group="bescheid"),
            TaxSectionEntry(slug="anlage-n", name="Anlage N", group="einkuenfte"),
        ]
        out = _tax_sections_outline(entries)
        lines = out.splitlines()
        # Einkünfte-Header must appear before Abzüge, Abzüge before Bescheide.
        idx_eink = next(i for i, l in enumerate(lines) if l.startswith("[Einkünfte"))
        idx_abz = next(i for i, l in enumerate(lines) if l.startswith("[Abzüge"))
        idx_bes = next(i for i, l in enumerate(lines) if l.startswith("[Bescheide"))
        assert idx_eink < idx_abz < idx_bes

    def test_includes_hint_when_present(self):
        entries = [
            TaxSectionEntry(
                slug="anlage-n",
                name="Anlage N",
                group="einkuenfte",
                hint="Lohnsteuerbescheinigung.",
            ),
        ]
        out = _tax_sections_outline(entries)
        assert "Lohnsteuerbescheinigung" in out
        assert "anlage-n: Anlage N" in out

    def test_unknown_group_not_dropped(self):
        # Defensive: a typo in `group` should still surface the entry so we
        # don't silently lose data during schema migrations.
        entries = [TaxSectionEntry(slug="x", name="X", group="typo")]
        out = _tax_sections_outline(entries)
        assert "x: X" in out
        assert "[typo]" in out
