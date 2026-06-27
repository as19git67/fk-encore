"""Unit tests for _repair_mojibake — UTF-8-as-Latin-1 repair."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from main import _repair_mojibake  # noqa: E402


class TestRepairMojibake:
    def test_repairs_classic_utf8_as_latin1(self):
        assert _repair_mojibake("BrÃ¼ssel") == "Brüssel"
        assert _repair_mojibake("KÃ¶ln") == "Köln"
        assert _repair_mojibake("MÃ¼nchen") == "München"

    def test_passes_clean_utf8_through(self):
        assert _repair_mojibake("Brüssel") == "Brüssel"
        assert _repair_mojibake("München") == "München"
        assert _repair_mojibake("Berlin") == "Berlin"

    def test_passes_none_through(self):
        assert _repair_mojibake(None) is None

    def test_leaves_plain_ascii_alone(self):
        assert _repair_mojibake("REWE") == "REWE"
        assert _repair_mojibake("") == ""

    def test_leaves_genuine_accented_alone(self):
        assert _repair_mojibake("café") == "café"
