"""Deterministic receipt semantics layered on top of OCR/LLM output."""

from __future__ import annotations

import datetime as dt
import re
import unicodedata
from typing import Any, Callable


_NUMERIC_DATE = re.compile(r"(?<!\d)(\d{1,2})\s*([./-])\s*(\d{1,2})\s*\2\s*(\d{2,4})(?!\d)")
_GERMAN_HINTS = (
    "germany", "deutschland", "gmbh", "mwst", "steuer", "summe", "zwischensumme",
    "rückgeld", "ruckgeld", "danke", "vielen dank", "st.nr", ".de", "straße", "str.",
)
_US_HINTS = ("sales tax", "subtotal", "change due", "thank you", " llc", " inc", " usa", "zip code")


def _iso_date(value: str | None) -> dt.date | None:
    if not value:
        return None
    try:
        return dt.date.fromisoformat(value[:10])
    except (TypeError, ValueError):
        return None


def _candidate(year: int, month: int, day: int) -> dt.date | None:
    if year < 100:
        year += 2000
    if year < 2010:
        return None
    try:
        return dt.date(year, month, day)
    except ValueError:
        return None


def resolve_receipt_date(
    text: str,
    model_date: str | None,
    reference_date: str | None = None,
    today: dt.date | None = None,
) -> str | None:
    """Resolve ambiguous numeric dates using capture proximity and locale hints.

    The raw OCR date remains authoritative over an LLM-normalized value because
    converting 05/07 to ISO already destroys whether the model assumed DMY or
    MDY. Capture/upload day is the strongest tie-breaker, followed by language
    and address signals. German DMY is the conservative deployment default.
    """
    today = today or dt.date.today()
    reference = _iso_date(reference_date)
    normalized = text.casefold()
    german_score = sum(1 for hint in _GERMAN_HINTS if hint in normalized)
    us_score = sum(1 for hint in _US_HINTS if hint in normalized)
    choices: list[dt.date] = []

    for match in _NUMERIC_DATE.finditer(text):
        first, second, year = int(match.group(1)), int(match.group(3)), int(match.group(4))
        dmy = _candidate(year, second, first)
        mdy = _candidate(year, first, second)
        valid = list(dict.fromkeys(candidate for candidate in (dmy, mdy) if candidate))
        if not valid:
            continue
        if len(valid) == 1:
            choices.append(valid[0])
            continue
        if reference:
            closest = min(valid, key=lambda candidate: abs((candidate - reference).days))
            distances = sorted(abs((candidate - reference).days) for candidate in valid)
            # Upload time is a strong hint only for freshly photographed
            # receipts. Old paper receipts may be scanned months later.
            if distances[0] <= 7 and distances[0] < distances[1]:
                choices.append(closest)
                continue
        choices.append(mdy if us_score > german_score else dmy)  # type: ignore[arg-type]

    if choices:
        anchor = reference or today
        plausible = [candidate for candidate in choices if candidate <= today + dt.timedelta(days=366)]
        if plausible:
            return min(plausible, key=lambda candidate: abs((candidate - anchor).days)).isoformat()

    parsed_model = _iso_date(model_date)
    return (
        parsed_model.isoformat()
        if parsed_model and parsed_model <= today + dt.timedelta(days=366)
        else None
    )


_PRICE_AT_END = re.compile(r"(?<!\d)(\d+(?:[.,]\d{2}))(?:\s*[€eE]|6)?\s*[A-Z]?\s*$")
_NON_ITEM_WORDS = (
    "summe", "gesamt", "total", "steuer", "mwst", "netto", "brutto", "rückgeld",
    "ruckgeld", "bar", "cash", "gegeben", "change", "karte", "visa", "mastercard",
    "barzahlung", "kartenzahlung", "zwischensumme", "subtotal", "rabatt", "coupon", "eur",
)


def _normalize(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().casefold()
    return " ".join(re.findall(r"[a-z0-9]+", value))


def _source_rows(text: str, layout_rows: list[dict[str, Any]] | None) -> list[str]:
    if layout_rows:
        rows = [str(row.get("text", "")).strip() for row in layout_rows if isinstance(row, dict)]
        if any(rows):
            return [row for row in rows if row]
    return [line.strip() for line in text.splitlines() if line.strip()]


def priced_item_candidates(
    text: str,
    layout_rows: list[dict[str, Any]] | None,
    parse_amount: Callable[[str], float | None],
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for row in _source_rows(text, layout_rows):
        normalized_row = _normalize(row)
        if any(re.search(rf"\b{re.escape(word)}\b", normalized_row) for word in _NON_ITEM_WORDS):
            continue
        price_match = _PRICE_AT_END.search(row)
        if not price_match:
            continue
        amount = parse_amount(price_match.group(1))
        name = row[:price_match.start()].replace("|", " ").strip(" -*")
        name = re.sub(r"^\d+\s*[x×%]\s*", "", name, flags=re.IGNORECASE)
        name = re.sub(r"^\d{8,14}\s+", "", name)
        name = re.sub(r"\s+", " ", name).strip()
        if amount is None or len(re.findall(r"[A-Za-zÄÖÜäöüß]", name)) < 3:
            continue
        candidates.append({"name": name, "amount": amount})
    return candidates


def validate_receipt_items(
    text: str,
    layout_rows: list[dict[str, Any]] | None,
    model_items: list[dict[str, Any]],
    parse_amount: Callable[[str], float | None],
) -> list[dict[str, Any]]:
    """Keep model items tied to priced rows; recover priced parent rows if needed."""
    candidates = priced_item_candidates(text, layout_rows, parse_amount)
    if not candidates:
        return model_items

    matched: list[dict[str, Any]] = []
    used: set[int] = set()
    for item in model_items:
        item_name = _normalize(str(item.get("name", "")))
        if not item_name:
            continue
        item_tokens = set(item_name.split())
        for index, candidate in enumerate(candidates):
            candidate_name = _normalize(str(candidate["name"]))
            overlap = len(item_tokens & set(candidate_name.split())) / max(1, len(item_tokens))
            if item_name in candidate_name or candidate_name in item_name or overlap >= 0.75:
                if index not in used:
                    matched.append({"name": str(item["name"]), "amount": candidate["amount"]})
                    used.add(index)
                break
    return matched or candidates
