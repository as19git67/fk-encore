"""Pydantic schema validation — no model load required."""

from __future__ import annotations

import os
import sys

import pytest
from pydantic import ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from main import PageOcrLine, PageOcrResult, ReceiptResult  # noqa: E402


class TestReceiptResult:
    def test_defaults(self):
        r = ReceiptResult()
        assert r.amount is None
        assert r.date is None
        assert r.store is None
        assert r.currency == "EUR"
        assert r.items == []
        assert r.raw_text == ""
        assert r.ocr_confidence == 0.0
        assert r.amount_confidence == 0.0
        assert r.amount_source is None
        assert r.layout_rows == []
        assert r.processing_ms == 0

    def test_full_result(self):
        r = ReceiptResult(
            amount=12.99,
            date="2025-03-15",
            store="REWE",
            currency="EUR",
            items=[{"name": "Milch", "amount": 1.29}],
            raw_text="REWE\nMilch 1,29\nGesamt 12,99",
            ocr_confidence=0.95,
            amount_confidence=0.995,
            amount_source="validated:label+payment:cash-minus-change",
            layout_rows=[{
                "text": "Milch | 1,29",
                "cells": [{"text": "Milch", "x": 0.1}],
            }],
            processing_ms=3500,
        )
        assert r.amount == 12.99
        assert r.store == "REWE"
        assert r.amount_confidence == 0.995
        assert r.amount_source == "validated:label+payment:cash-minus-change"
        assert len(r.layout_rows) == 1
        assert len(r.items) == 1

    def test_none_amount(self):
        r = ReceiptResult(amount=None)
        assert r.amount is None

    def test_zero_confidence(self):
        r = ReceiptResult(ocr_confidence=0.0)
        assert r.ocr_confidence == 0.0


class TestPageOcrResult:
    """The generic document-page endpoint's contract.

    documents/receipt-ocr-client.ts decodes exactly these fields and feeds the
    boxes into the OCR resolver's geometric alignment, so a rename here breaks
    the second-engine comparison silently — the client would see empty lines
    and simply report "no second opinion" instead of failing.
    """

    def test_defaults(self):
        r = PageOcrResult()
        assert r.lines == []
        assert r.full_text == ""
        assert r.mean_confidence == 0.0
        assert r.processing_ms == 0

    def test_line_carries_box_and_confidence(self):
        r = PageOcrResult(
            lines=[
                PageOcrLine(
                    text="23 AUG 02",
                    confidence=0.94,
                    left=469.0,
                    top=500.0,
                    right=592.0,
                    bottom=518.0,
                )
            ],
            full_text="23 AUG 02",
            mean_confidence=0.94,
            processing_ms=1800,
        )
        assert r.lines[0].text == "23 AUG 02"
        assert r.lines[0].confidence == 0.94
        assert r.lines[0].right == 592.0

    def test_line_requires_a_full_box(self):
        with pytest.raises(ValidationError):
            PageOcrLine(text="x", confidence=0.5, left=1.0, top=2.0)
