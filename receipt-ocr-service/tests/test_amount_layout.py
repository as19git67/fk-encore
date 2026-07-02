"""Tests for geometry-aware receipt total selection."""

from receipt_amount import decide_layout_amount, decide_text_amount


def _rows(*texts: str):
    return [{"text": text} for text in texts]


def test_rossmann_total_is_validated_by_cash_minus_change():
    rows = _rows(
        "Zwischensumme: | 9,78",
        "Ihre CouponErsparnis heute | 0,98",
        "summe Sie haben insgesamt c0,98 gespart! | 8,80",
        "Bar | €10,00 | €1,20",
        "Ruckgeld Bar",
    )

    decision = decide_layout_amount(rows)

    assert decision.amount == 8.80
    assert decision.confidence == 0.995
    assert decision.source == "validated:label+payment:cash-minus-change+discount:subtotal-minus-discount"


def test_rightmost_total_wins_over_coupon_amount_in_merged_row():
    decision = decide_layout_amount(
        _rows("Summe Coupon-Ersparnis 0,98 | 8,80")
    )
    assert decision.amount == 8.80
    assert decision.source == "label:same-row"


def test_subtotal_is_not_a_final_total():
    decision = decide_layout_amount(_rows("Zwischensumme | 9,78"))
    assert decision.amount is None


def test_fuzzy_total_label_handles_common_ocr_typo():
    decision = decide_layout_amount(_rows("Sunme | 8,80"))
    assert decision.amount == 8.80
    assert decision.confidence == 0.90


def test_cash_minus_change_is_safe_fallback():
    decision = decide_layout_amount(
        _rows("Bar | 10,00", "Rückgeld Bar | 1,20")
    )
    assert decision.amount == 8.80
    assert decision.confidence == 0.92
    assert decision.source == "payment:cash-minus-change"


def test_subtotal_minus_coupon_is_independent_fallback():
    decision = decide_layout_amount(
        _rows("Zwischensumme | 9,78", "Coupon-Ersparnis | 0,98")
    )
    assert decision.amount == 8.80
    assert decision.confidence == 0.90
    assert decision.source == "discount:subtotal-minus-discount"


def test_card_payment_is_lower_confidence_fallback():
    decision = decide_layout_amount(_rows("Kartenzahlung VISA | 8,80"))
    assert decision.amount == 8.80
    assert decision.confidence == 0.88
    assert decision.source == "payment:card"


def test_text_compatibility_uses_last_amount_on_total_line():
    text = "summe Sie haben 0,98 gespart! 8,80\nBar 10,00 1,20\nRuckgeld Bar"
    decision = decide_text_amount(text, llm_amount=10.0)
    assert decision.amount == 8.80
    assert decision.confidence == 0.995
