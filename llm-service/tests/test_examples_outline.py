"""Tests for the few-shot examples formatter used in the classify prompt."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from main import ExampleEntry, _examples_outline  # noqa: E402


def test_empty():
    assert _examples_outline([]) == ""


def test_single_with_sender_and_name():
    out = _examples_outline(
        [
            ExampleEntry(
                category_slug="finanzen-gehalt",
                category_name="Gehalt",
                title="Entgeltabrechnung Mai",
                sender="Contoso",
            )
        ]
    )
    assert out == "- Absender: Contoso | Titel: Entgeltabrechnung Mai → finanzen-gehalt (Gehalt)"


def test_missing_sender_falls_back_to_unbekannt():
    out = _examples_outline(
        [ExampleEntry(category_slug="sonstiges", title="Brief", sender=None)]
    )
    assert "Absender: unbekannt" in out
    # No category name → slug rendered bare, without parentheses.
    assert out.endswith("→ sonstiges")


def test_multiple_lines_in_order():
    out = _examples_outline(
        [
            ExampleEntry(category_slug="a", category_name="A", title="Erstes", sender="X"),
            ExampleEntry(category_slug="b", category_name="B", title="Zweites", sender="Y"),
        ]
    )
    lines = out.splitlines()
    assert len(lines) == 2
    assert "Erstes" in lines[0] and "→ a (A)" in lines[0]
    assert "Zweites" in lines[1] and "→ b (B)" in lines[1]
