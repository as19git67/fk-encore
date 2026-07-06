import datetime as dt

from receipt_amount import parse_amount
from receipt_semantics import resolve_receipt_date, validate_receipt_items


FIVE_GUYS = """FIVE GUYS Germany Gmbh
Pasinger Bahnhofsp1. 5/Unit 138
München,81241
Order #166
05/07/2026
12:13:25
1x Cheeseburger Brötchen | 12.256
Salat
Gegrillte Zwiebeln
Ketchup
Senf
1x Little Bacon Burger Brötchen | 9.75€
Salat
Tomaten
Gewürzgurken
HP Sauce
Zwischensumme | 20,56€
MwSt 7% Steuer | 1,44€
Im Haus Summe | 22,00"""


def test_german_receipt_corrects_llm_mdy_assumption():
    assert resolve_receipt_date(
        FIVE_GUYS,
        "2026-05-07",
        today=dt.date(2026, 7, 6),
    ) == "2026-07-05"


def test_capture_day_breaks_ambiguous_date_tie():
    assert resolve_receipt_date(
        "Cafe\n03/04/2026\nTotal 5.00",
        "2026-03-04",
        reference_date="2026-04-03",
        today=dt.date(2026, 4, 4),
    ) == "2026-04-03"


def test_us_language_keeps_month_day_order_without_capture_hint():
    assert resolve_receipt_date(
        "THANK YOU\nSales Tax 1.20\n05/07/2026\nTotal $12.00",
        "2026-05-07",
        today=dt.date(2026, 7, 6),
    ) == "2026-05-07"


def test_old_scan_uses_country_instead_of_distant_upload_date():
    assert resolve_receipt_date(
        "THANK YOU\nSales Tax 1.20\n05/07/2026\nTotal $12.00",
        "2026-05-07",
        reference_date="2026-12-01",
        today=dt.date(2026, 12, 1),
    ) == "2026-05-07"


def test_unpriced_toppings_are_replaced_by_priced_parent_items():
    wrong = [
        {"name": "Salat", "amount": 12.26},
        {"name": "Gegrillte Zwiebeln", "amount": 12.26},
        {"name": "Ketchup", "amount": 12.26},
        {"name": "Senf", "amount": 12.26},
        {"name": "Tomaten", "amount": 9.75},
        {"name": "HP Sauce", "amount": 9.75},
    ]
    assert validate_receipt_items(FIVE_GUYS, [], wrong, parse_amount) == [
        {"name": "Cheeseburger Brötchen", "amount": 12.25},
        {"name": "Little Bacon Burger Brötchen", "amount": 9.75},
    ]


def test_regular_priced_model_items_are_preserved_and_verified():
    text = "REWE\nVollmilch 1,29€\nBrot 2,49€\nSUMME 3,78€"
    items = [
        {"name": "Vollmilch", "amount": 1.29},
        {"name": "Brot", "amount": 2.49},
    ]
    assert validate_receipt_items(text, [], items, parse_amount) == items


def test_payment_and_total_rows_never_become_fallback_items():
    text = "Milch 1,29€\nSUMME 1,29€\nBar 2,00€\nRückgeld 0,71€"
    assert validate_receipt_items(text, [], [], parse_amount) == [
        {"name": "Milch", "amount": 1.29},
    ]
