"""Tests for rebuilding receipt rows from PaddleOCR text boxes."""

from main import _reconstruct_visual_lines


def _line(text: str, left: float, top: float, right: float, bottom: float):
    return {
        "text": text,
        "confidence": 0.99,
        "x": (left + right) / 2,
        "y": (top + bottom) / 2,
        "top": top,
        "bottom": bottom,
        "box": [[left, top], [right, top], [right, bottom], [left, bottom]],
    }


def test_joins_product_quantity_and_price_on_same_visual_row():
    lines = [
        _line("1x", 10, 20, 35, 40),
        _line("Vollmilch", 45, 21, 170, 41),
        _line("1,29", 280, 19, 330, 39),
    ]

    assert _reconstruct_visual_lines(lines) == ["1x Vollmilch | 1,29"]


def test_keeps_neighbouring_receipt_rows_separate():
    lines = [
        _line("Vollmilch", 10, 20, 170, 38),
        _line("1,29", 280, 20, 330, 38),
        _line("Brot", 10, 44, 170, 62),
        _line("2,49", 280, 44, 330, 62),
    ]

    assert _reconstruct_visual_lines(lines) == [
        "Vollmilch | 1,29",
        "Brot | 2,49",
    ]


def test_tolerates_slightly_skewed_boxes_on_one_row():
    lines = [
        _line("Äpfel", 10, 20, 130, 40),
        _line("2,99", 280, 25, 330, 45),
    ]

    assert _reconstruct_visual_lines(lines) == ["Äpfel | 2,99"]


def test_does_not_merge_adjacent_rows_just_because_boxes_overlap():
    lines = [
        _line("Coupon 0,98", 40, 20, 210, 48),
        _line("Summe", 10, 43, 120, 70),
        _line("8,80", 280, 44, 330, 71),
    ]

    assert _reconstruct_visual_lines(lines) == [
        "Coupon 0,98",
        "Summe | 8,80",
    ]
