"""Unit tests for regex_extract and _parse_german_amount — no model load required."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from main import _parse_german_amount, regex_extract  # noqa: E402


class TestParseGermanAmount:
    def test_comma_decimal(self):
        assert _parse_german_amount("12,99") == 12.99

    def test_dot_thousand_comma_decimal(self):
        assert _parse_german_amount("1.234,56") == 1234.56

    def test_space_thousand(self):
        assert _parse_german_amount("1 234,56") == 1234.56

    def test_plain_integer(self):
        assert _parse_german_amount("42,00") == 42.0

    def test_dot_decimal_english_style(self):
        assert _parse_german_amount("9.99") == 9.99

    def test_zero_returns_none(self):
        assert _parse_german_amount("0,00") is None

    def test_negative_returns_none(self):
        assert _parse_german_amount("-5,00") is None

    def test_garbage_returns_none(self):
        assert _parse_german_amount("abc") is None


class TestRegexExtract:
    def test_total_with_gesamt_label(self):
        text = "Artikel 1   2,50\nArtikel 2   3,49\nGESAMT   5,99"
        result = regex_extract(text)
        assert result["amount"] == 5.99

    def test_total_with_summe_label(self):
        text = "Pos 1  1,00\nSumme  1,00"
        result = regex_extract(text)
        assert result["amount"] == 1.00

    def test_total_with_zu_zahlen(self):
        text = "Zwischensumme  10,00\nMwSt  1,90\nZu zahlen  11,90"
        result = regex_extract(text)
        assert result["amount"] == 11.90

    def test_kartenzahlung_label(self):
        text = "Summe  25,00\nKartenzahlung  25,00"
        result = regex_extract(text)
        assert result["amount"] == 25.00

    def test_ec_cash_label(self):
        text = "Total  8,50\nEC-Cash  8,50"
        result = regex_extract(text)
        assert result["amount"] == 8.50

    def test_cash_tendered_does_not_override_total(self):
        text = "Bar  20,00\nRückgeld  7,66\nSUMME  12,34"
        result = regex_extract(text)
        assert result["amount"] == 12.34

    def test_card_payment_does_not_override_total(self):
        text = "VISA  50,00\nZu zahlen  47,25"
        result = regex_extract(text)
        assert result["amount"] == 47.25

    def test_deutsche_post_bruttoumsatz_beats_cash_and_change(self):
        text = (
            "Deutsche Post AG\nBruttoumsatz\n*7,69 EUR\n"
            "20.70 EUR\nBarzahlung\nnsbsn1o13.01EUR\n"
            "Rückgeld/Auszahlung"
        )
        result = regex_extract(text)
        assert result["amount"] == 7.69

    def test_eur_label(self):
        text = "Banane  0,99\nBrot  2,49\nEUR  3,48"
        result = regex_extract(text)
        assert result["amount"] == 3.48

    def test_fallback_last_amount(self):
        text = "Milch  1,29\nButter  2,49\n3,78"
        result = regex_extract(text)
        assert result["amount"] == 3.78

    def test_no_amount(self):
        text = "Kein Betrag hier"
        result = regex_extract(text)
        assert result["amount"] is None

    def test_date_extraction_german(self):
        text = "Datum: 15.03.2025\nSumme 5,00"
        result = regex_extract(text)
        assert result["date"] == "2025-03-15"

    def test_date_short_year(self):
        text = "15.03.25\nGesamt 5,00"
        result = regex_extract(text)
        assert result["date"] == "2025-03-15"

    def test_invalid_date_skipped(self):
        text = "99.99.2025\nSumme 5,00"
        result = regex_extract(text)
        assert result["date"] is None

    def test_currency_default_eur(self):
        result = regex_extract("Summe 1,00")
        assert result["currency"] == "EUR"

    def test_store_always_none(self):
        result = regex_extract("REWE\nSumme 1,00")
        assert result["store"] is None

    def test_items_always_empty(self):
        result = regex_extract("Summe 1,00")
        assert result["items"] == []

    def test_large_amount_dot_thousand(self):
        text = "Gesamtbetrag  1.234,56"
        result = regex_extract(text)
        assert result["amount"] == 1234.56
