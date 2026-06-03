"""Tests for the taxonomy-outline formatter used in the classify prompt."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from main import TaxonomyNode, _taxonomy_outline  # noqa: E402


def test_empty():
    assert _taxonomy_outline([]) == ""


def test_single_root():
    out = _taxonomy_outline([TaxonomyNode(slug="finanzen", name="Finanzen")])
    assert out == "- finanzen: Finanzen"


def test_nested_children_indented():
    nodes = [
        TaxonomyNode(slug="finanzen", name="Finanzen"),
        TaxonomyNode(slug="rechnungen", name="Rechnungen", parent_slug="finanzen"),
        TaxonomyNode(slug="steuern", name="Steuern", parent_slug="finanzen"),
    ]
    out = _taxonomy_outline(nodes)
    lines = out.splitlines()
    assert lines[0] == "- finanzen: Finanzen"
    assert lines[1].startswith("  - ")
    assert "rechnungen" in lines[1]
    assert lines[2].startswith("  - ")
    assert "steuern" in lines[2]


def test_three_levels_deep():
    nodes = [
        TaxonomyNode(slug="wohnen", name="Wohnen"),
        TaxonomyNode(slug="nebenkosten", name="Nebenkosten", parent_slug="wohnen"),
        TaxonomyNode(slug="strom", name="Strom", parent_slug="nebenkosten"),
    ]
    out = _taxonomy_outline(nodes)
    lines = out.splitlines()
    assert lines[0] == "- wohnen: Wohnen"
    assert lines[1] == "  - nebenkosten: Nebenkosten"
    assert lines[2] == "    - strom: Strom"


def test_orphan_nodes_skipped():
    # A parent_slug that does not match any node is ignored — only reachable
    # from a declared root. This mirrors what the LLM sees.
    nodes = [
        TaxonomyNode(slug="finanzen", name="Finanzen"),
        TaxonomyNode(slug="geist", name="Geist", parent_slug="ghost"),
    ]
    out = _taxonomy_outline(nodes)
    assert "geist" not in out
    assert "finanzen" in out


def test_hint_rendered_when_present():
    nodes = [
        TaxonomyNode(slug="finanzen", name="Finanzen"),
        TaxonomyNode(
            slug="wertpapiere",
            name="Wertpapiere & Dividenden",
            parent_slug="finanzen",
            hint="Dividendengutschriften und Steuermitteilungen zu Wertpapieren.",
        ),
        TaxonomyNode(slug="rechnungen", name="Rechnungen", parent_slug="finanzen"),
    ]
    out = _taxonomy_outline(nodes)
    lines = out.splitlines()
    # Hinted node renders "slug: Name — Hinweis"; un-hinted node stays plain.
    assert lines[1] == (
        "  - wertpapiere: Wertpapiere & Dividenden "
        "— Dividendengutschriften und Steuermitteilungen zu Wertpapieren."
    )
    assert lines[2] == "  - rechnungen: Rechnungen"


def test_multiple_roots_preserved():
    nodes = [
        TaxonomyNode(slug="a", name="A"),
        TaxonomyNode(slug="b", name="B"),
    ]
    out = _taxonomy_outline(nodes)
    assert "- a: A" in out
    assert "- b: B" in out
