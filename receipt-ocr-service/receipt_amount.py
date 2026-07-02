"""Geometry-aware receipt amount extraction and validation.

This module deliberately has no OpenCV dependency so its decision logic can be
tested independently from the OCR runtime. Rows are dictionaries produced by
``main._build_visual_rows`` and retain Paddle's ordered text boxes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any


VALUE_PATTERN = r"(?<!\d)(\d{1,3}(?:[. ]\d{3})*(?:,\d{2})|\d+(?:[.,]\d{2}))(?!\d)"
_VALUE_RE = re.compile(VALUE_PATTERN)
_NON_LETTERS = re.compile(r"[^a-zäöüß]+")

_TOTAL_WORDS = ("summe", "gesamt", "gesamtbetrag", "total", "betrag", "endsumme", "bruttoumsatz")
_PAYMENT_WORDS = ("bar", "gegeben", "cash")
_CARD_WORDS = ("kartenzahlung", "karte", "visa", "mastercard", "girocard", "ec")
_CHANGE_WORDS = ("rückgeld", "ruckgeld", "wechselgeld", "auszahlung")
_PROMO_WORDS = ("coupon", "ersparnis", "gespart", "rabatt", "aktion")


@dataclass(frozen=True)
class AmountDecision:
    amount: float | None
    confidence: float
    source: str


def parse_amount(raw: str) -> float | None:
    normalized = re.sub(r"[. ](?=\d{3}(?:\D|$))", "", raw).replace(",", ".")
    try:
        value = float(normalized)
    except ValueError:
        return None
    return round(value, 2) if value > 0 else None


def amounts_in_text(text: str) -> list[float]:
    values = [parse_amount(match.group(1)) for match in _VALUE_RE.finditer(text)]
    return [value for value in values if value is not None]


def _words(text: str) -> list[str]:
    normalized = (
        text.lower()
        .replace("0", "o")
        .replace("$", "s")
        .replace("§", "s")
    )
    return [word for word in _NON_LETTERS.split(normalized) if word]


def _word_matches(word: str, expected: str) -> bool:
    if word == expected:
        return True
    if len(word) < 4 or len(expected) < 4:
        return False
    if expected in word or word in expected:
        return True
    return SequenceMatcher(None, word, expected).ratio() >= 0.80


def _contains_word(text: str, expected: str) -> bool:
    return any(_word_matches(word, expected) for word in _words(text))


def _total_label_strength(text: str) -> float:
    words = _words(text)
    joined = "".join(words)
    if "zwischensumme" in joined or "subtotal" in joined:
        # A separately recognised final label may still occur later in the same
        # noisy row; require it as its own token in that case.
        standalone = [word for word in words if word != "zwischensumme"]
        if not any(_word_matches(word, "summe") for word in standalone):
            return 0.0
    if "zu" in words and any(_word_matches(word, "zahlen") for word in words):
        return 1.0
    for expected in _TOTAL_WORDS:
        for word in words:
            if word == expected:
                return 1.0
            if _word_matches(word, expected):
                return 0.90
    return 0.0


def looks_amount_related(text: str) -> bool:
    """Whether a row is useful as a target for a focused second OCR pass."""
    return bool(
        _total_label_strength(text)
        or any(_contains_word(text, word) for word in _PAYMENT_WORDS + _CARD_WORDS + _CHANGE_WORDS)
    )


def _row_amounts(row: dict[str, Any]) -> list[float]:
    # Row text preserves left-to-right order and therefore makes the final
    # amount the right-most candidate even when a promotional sentence was
    # accidentally merged into the total row.
    return amounts_in_text(str(row.get("text", "")))


def decide_layout_amount(rows: list[dict[str, Any]]) -> AmountDecision:
    """Choose the payable total from structured receipt rows.

    Explicit total labels win. On such rows the right-most amount is selected,
    matching common receipt layout and avoiding intervening coupon values.
    Cash tendered minus change is an independent validation/fallback signal.
    """
    labelled: list[AmountDecision] = []
    tendered: float | None = None
    change: float | None = None
    card_amount: float | None = None
    subtotal: float | None = None
    discount: float | None = None

    for index, row in enumerate(rows):
        text = str(row.get("text", ""))
        values = _row_amounts(row)
        normalized_words = _words(text)
        joined_words = "".join(normalized_words)
        strength = _total_label_strength(text)
        if ("zwischensumme" in joined_words or "subtotal" in joined_words) and values:
            subtotal = values[-1]
        if (
            not strength
            and any(_contains_word(text, word) for word in _PROMO_WORDS)
            and values
        ):
            discount = values[-1]
        if strength:
            candidate_values = values
            source_suffix = "same-row"
            if not candidate_values and index + 1 < len(rows):
                candidate_values = _row_amounts(rows[index + 1])
                source_suffix = "next-row"
            if candidate_values:
                confidence = 0.98 if strength == 1.0 and source_suffix == "same-row" else 0.90
                if any(_contains_word(text, word) for word in _PROMO_WORDS):
                    # Still reliable because the right-most value is used, but
                    # record a small uncertainty caused by merged promo text.
                    confidence -= 0.03
                labelled.append(AmountDecision(candidate_values[-1], confidence, f"label:{source_suffix}"))

        is_change = any(_contains_word(text, word) for word in _CHANGE_WORDS)
        is_payment = any(_contains_word(text, word) for word in _PAYMENT_WORDS)
        is_card = any(_contains_word(text, word) for word in _CARD_WORDS)
        if is_change and values:
            change = values[-1]
        if is_payment and values:
            if len(values) >= 2 and not is_change:
                # OCR sometimes merges the adjacent Bar and Rückgeld rows.
                tendered, change = values[0], values[-1]
            elif not is_change:
                tendered = values[-1]
        if is_card and values:
            card_amount = values[-1]

    arithmetic: AmountDecision | None = None
    if tendered is not None and change is not None and tendered > change:
        arithmetic = AmountDecision(round(tendered - change, 2), 0.92, "payment:cash-minus-change")

    discount_arithmetic: AmountDecision | None = None
    if subtotal is not None and discount is not None and subtotal > discount:
        discount_arithmetic = AmountDecision(
            round(subtotal - discount, 2),
            0.90,
            "discount:subtotal-minus-discount",
        )

    card = (
        AmountDecision(card_amount, 0.88, "payment:card")
        if card_amount is not None
        else None
    )

    if labelled:
        best = max(labelled, key=lambda candidate: candidate.confidence)
        validators = [candidate for candidate in (arithmetic, discount_arithmetic, card) if candidate]
        matching = [candidate for candidate in validators if abs(best.amount - candidate.amount) <= 0.01]
        if matching:
            sources = "+".join(candidate.source for candidate in matching)
            return AmountDecision(best.amount, 0.995, f"validated:label+{sources}")
        return best
    if arithmetic:
        return arithmetic
    if discount_arithmetic:
        return discount_arithmetic
    if card:
        return card
    return AmountDecision(None, 0.0, "unresolved")


def decide_text_amount(text: str, llm_amount: float | None = None) -> AmountDecision:
    """Text-only compatibility path using the same semantic rules."""
    rows = [{"text": line.strip()} for line in text.splitlines() if line.strip()]
    decision = decide_layout_amount(rows)
    if decision.amount is not None:
        return decision
    if llm_amount is not None and llm_amount > 0:
        return AmountDecision(round(float(llm_amount), 2), 0.55, "llm")
    values = amounts_in_text(text)
    if values:
        return AmountDecision(values[-1], 0.25, "fallback:last-amount")
    return decision
