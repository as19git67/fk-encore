"""Tests for the core/items split of the LLM extraction.

The LLM isn't loaded during unit tests (_state["llm"] is None), so these
exercise the regex/empty fallback paths of the split functions.
"""

from main import (
    ItemsRequest,
    ItemsResult,
    _layout_text_for_items,
    _state,
    llm_extract_core,
    llm_extract_items,
)


def test_llm_extract_core_keys_and_regex_fallback():
    text = "REWE Markt\nMilch 1,99\nBrot 2,49\nSUMME 4,48\n27.06.2026"
    core = llm_extract_core(text)
    # Core never carries items, only the save-critical fields.
    assert set(core.keys()) == {"amount", "date", "store", "currency"}
    assert core["amount"] == 4.48          # regex picks the labelled total
    assert core["currency"] == "EUR"
    assert core["store"] is None           # regex fallback can't name the store


def test_llm_extract_items_empty_without_llm():
    # No LLM loaded -> no items (never raises, returns []).
    assert llm_extract_items("REWE\nMilch 1,99\nBrot 2,49") == []


def test_items_request_and_result_defaults():
    assert ItemsRequest().text == ""
    assert ItemsRequest().layout_rows == []
    assert ItemsRequest(text="abc").text == "abc"
    r = ItemsResult()
    assert r.items == []
    assert r.processing_ms == 0


def test_item_prompt_preserves_normalized_cell_positions():
    layout_rows = [{
        "text": "Vollmilch | 1,29",
        "cells": [
            {"text": "Vollmilch", "x": 0.08},
            {"text": "1,29", "x": 0.82},
        ],
    }]

    formatted = _layout_text_for_items("Vollmilch | 1,29", layout_rows)

    assert "@0.08 Vollmilch" in formatted
    assert "@0.82 1,29" in formatted


def test_explicit_bruttoumsatz_overrides_llm_cash_guess():
    class FakeLlm:
        def create_chat_completion(self, **_kwargs):
            return {
                "choices": [{
                    "message": {
                        "content": '{"amount":13.01,"date":null,"store":"Deutsche Post","currency":"EUR"}'
                    }
                }]
            }

    previous = _state["llm"]
    _state["llm"] = FakeLlm()
    try:
        result = llm_extract_core(
            "Deutsche Post AG\nBruttoumsatz\n*7,69 EUR\n"
            "20.70 EUR\nBarzahlung\nnsbsn1o13.01EUR\nRückgeld/Auszahlung"
        )
    finally:
        _state["llm"] = previous

    assert result["amount"] == 7.69
