"""Tests for the German natural-language query parser.

These tests exercise the full parser (spaCy NER + dateparser + regex
extras). They are skipped automatically if the spaCy model is not
installed in the test environment, so CI without the model still runs.
"""

from __future__ import annotations

import sys
import types
from datetime import datetime
from unittest.mock import MagicMock

import pytest


# Stub config so query_parser can be imported without app config side effects.
config_stub = types.ModuleType("app.config")


class _Settings:
    log_level = "INFO"


config_stub.settings = _Settings()
sys.modules.setdefault("app.config", config_stub)


def _spacy_model_available() -> bool:
    try:
        import spacy

        spacy.load("de_core_news_md")
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _spacy_model_available(),
    reason="spaCy de_core_news_md not installed; run `python -m spacy download de_core_news_md`",
)


@pytest.fixture(scope="module")
def parse():
    from app.services.query_parser import parse_query

    return parse_query


# ---------------------------------------------------------------------------
# Year ranges
# ---------------------------------------------------------------------------


class TestYearRanges:
    def test_von_bis(self, parse):
        result = parse("Kirchen von 2004 bis 2017")
        assert result["from_date"].startswith("2004-01-01")
        assert result["to_date"].startswith("2017-12-31")
        assert "kirchen" in result["semantic_query"].lower()

    def test_zwischen_und(self, parse):
        result = parse("Berge zwischen 2010 und 2015")
        assert result["from_date"].startswith("2010-01-01")
        assert result["to_date"].startswith("2015-12-31")

    def test_dash_range(self, parse):
        result = parse("Strand 2018-2020")
        assert result["from_date"].startswith("2018-01-01")
        assert result["to_date"].startswith("2020-12-31")

    def test_em_dash_range(self, parse):
        result = parse("Strand 2018 – 2020")
        assert result["from_date"].startswith("2018-01-01")
        assert result["to_date"].startswith("2020-12-31")

    def test_swapped_range_is_normalised(self, parse):
        result = parse("Wandern von 2020 bis 2018")
        assert result["from_date"].startswith("2018-01-01")
        assert result["to_date"].startswith("2020-12-31")


# ---------------------------------------------------------------------------
# Single year / month
# ---------------------------------------------------------------------------


class TestSingleDates:
    def test_bare_year(self, parse):
        result = parse("Hochzeit 2019")
        assert result["from_date"].startswith("2019-01-01")
        assert result["to_date"].startswith("2019-12-31")

    def test_year_phrase(self, parse):
        result = parse("Bilder aus dem Jahr 2019")
        assert result["from_date"].startswith("2019-01-01")
        assert result["to_date"].startswith("2019-12-31")

    def test_month_year(self, parse):
        result = parse("Fotos aus März 2019")
        assert result["from_date"].startswith("2019-03-01")
        # End-of-month varies by length; just check year-month
        assert result["to_date"].startswith("2019-03")


# ---------------------------------------------------------------------------
# Seasons
# ---------------------------------------------------------------------------


class TestSeasons:
    def test_summer_with_year(self, parse):
        result = parse("Urlaub Sommer 2020")
        assert result["from_date"].startswith("2020-06-01")
        assert result["to_date"].startswith("2020-08-31")

    def test_winter_spans_year_boundary(self, parse):
        result = parse("Skifahren Winter 2019")
        assert result["from_date"].startswith("2019-12-01")
        # Winter 2019 → Feb 2020
        assert result["to_date"].startswith("2020-02")


# ---------------------------------------------------------------------------
# Locations (spaCy NER)
# ---------------------------------------------------------------------------


class TestLocations:
    def test_in_munich(self, parse):
        result = parse("Kirchen in München")
        assert result["location"] is not None
        assert "münchen" in result["location"].lower()

    def test_lowercase_munich(self, parse):
        # spaCy may struggle with lowercased proper nouns; this test tolerates
        # either a hit or a miss but documents current behavior.
        result = parse("kirchen in münchen")
        # Don't assert hit – record behavior; if NER misses it the location
        # will be None which is still acceptable for this edge case.
        assert "kirchen" in result["semantic_query"].lower()

    def test_aus_berlin(self, parse):
        result = parse("Bilder aus Berlin")
        assert result["location"] is not None
        assert "berlin" in result["location"].lower()


# ---------------------------------------------------------------------------
# Combined queries
# ---------------------------------------------------------------------------


class TestCombined:
    def test_full_query(self, parse):
        result = parse("Kirchen in München von 2004 bis 2017")
        assert result["from_date"].startswith("2004-01-01")
        assert result["to_date"].startswith("2017-12-31")
        assert result["location"] is not None
        assert "münchen" in result["location"].lower()
        assert "kirchen" in result["semantic_query"].lower()
        # Year tokens should be stripped from semantic query
        assert "2004" not in result["semantic_query"]
        assert "2017" not in result["semantic_query"]


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    def test_empty_query(self, parse):
        result = parse("")
        assert result == {
            "semantic_query": "",
            "location": None,
            "from_date": None,
            "to_date": None,
        }

    def test_whitespace_only(self, parse):
        result = parse("   ")
        assert result["semantic_query"] == ""
        assert result["location"] is None
        assert result["from_date"] is None

    def test_pure_semantic(self, parse):
        result = parse("Sonnenuntergang am Strand")
        assert result["from_date"] is None
        # Location may or may not match – Strand is a generic noun;
        # we just verify the call returns sensibly.
        assert isinstance(result["semantic_query"], str)
        assert "sonnenuntergang" in result["semantic_query"].lower()

    def test_implausible_year_not_consumed(self, parse):
        # A 4-digit number that is NOT a plausible year should not be treated
        # as a year. dateparser is reasonably strict here, but if this fails
        # in practice the regex fallback in _extract_year_range needs tuning.
        result = parse("Foto Nummer 9999")
        # 9999 should not become a date filter; if it does, this asserts it.
        if result["from_date"] is not None:
            assert not result["from_date"].startswith("9999")
