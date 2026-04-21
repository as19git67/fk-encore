"""Unit tests for ``_repair_mojibake`` — the UTF-8-as-Latin-1 repair that
neutralises the llama-cpp-python JSON-grammar tokeniser bug at the source."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from main import _repair_fields, _repair_mojibake, _repair_tags  # noqa: E402


class TestRepairMojibake:
    def test_repairs_classic_utf8_as_latin1(self):
        assert _repair_mojibake("BrÃ¼ssel") == "Brüssel"
        assert _repair_mojibake("KÃ¶ln") == "Köln"
        assert _repair_mojibake("MÃ¼nchen") == "München"
        assert _repair_mojibake("Garching bei MÃ¼nchen") == "Garching bei München"

    def test_passes_clean_utf8_through(self):
        assert _repair_mojibake("Brüssel") == "Brüssel"
        assert _repair_mojibake("München") == "München"
        assert _repair_mojibake("Berlin") == "Berlin"
        assert _repair_mojibake("") == ""

    def test_passes_none_through(self):
        assert _repair_mojibake(None) is None

    def test_leaves_genuine_latin1_alone(self):
        # "café" has a single high-bit char but no Ã/Â lead byte — not mojibake.
        assert _repair_mojibake("café") == "café"

    def test_leaves_emoji_containing_strings_alone(self):
        # Outside-Latin-1 chars (e.g. emoji) would raise on .encode("latin-1"),
        # so the function must catch and return the original unchanged.
        s = "Ausflug Ã¼ber den Bodensee 🌅"
        # We don't assert the repaired form (the emoji makes it non-round-trippable)
        # — only that the call returns a string rather than raising.
        result = _repair_mojibake(s)
        assert isinstance(result, str)


class TestRepairFields:
    def test_rewrites_only_requested_keys(self):
        data = {"title": "BrÃ¼ssel", "sender": "KÃ¶ln", "other": "BrÃ¼ssel"}
        _repair_fields(data, ("title", "sender"))
        assert data["title"] == "Brüssel"
        assert data["sender"] == "Köln"
        # `other` was not in the whitelist, stays untouched.
        assert data["other"] == "BrÃ¼ssel"

    def test_skips_non_string_values(self):
        data = {"title": None, "confidence": 0.8, "tags": ["a", "b"]}
        _repair_fields(data, ("title", "confidence", "tags"))
        assert data["title"] is None
        assert data["confidence"] == 0.8
        assert data["tags"] == ["a", "b"]


class TestRepairTags:
    def test_repairs_each_string_entry(self):
        data = {"tags": ["urlaub", "brÃ¼ssel", "kÃ¶ln", "berlin"]}
        _repair_tags(data)
        assert data["tags"] == ["urlaub", "brüssel", "köln", "berlin"]

    def test_skips_non_list(self):
        data = {"tags": None}
        _repair_tags(data)
        assert data["tags"] is None

    def test_leaves_non_string_entries_untouched(self):
        data = {"tags": ["ok", 42, None]}
        _repair_tags(data)
        assert data["tags"] == ["ok", 42, None]
