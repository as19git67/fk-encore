"""Tests for the core/items split of the LLM extraction.

The LLM isn't loaded during unit tests (_state["llm"] is None), so these
exercise the regex/empty fallback paths of the split functions.
"""

from main import ItemsRequest, ItemsResult, llm_extract_core, llm_extract_items


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
    assert ItemsRequest(text="abc").text == "abc"
    r = ItemsResult()
    assert r.items == []
    assert r.processing_ms == 0
