"""Natural-language query parser for German photo search.

Combines spaCy NER (for locations) with dateparser (for absolute and relative
date expressions) to extract structured filters from a free-form German query.

Output fields are aligned with what `searchPhotosNaturalLogic` in
`photo/photo.service.ts` consumes, so the TypeScript side can drop in this
parser instead of the in-process regex parser.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)

# spaCy + dateparser are heavy imports. Defer them so the rest of the service
# (e.g. /health, /embed) doesn't pay the load cost on cold start.
_nlp = None  # type: ignore[assignment]


def _get_nlp():
    """Lazy-load the German spaCy pipeline."""
    global _nlp
    if _nlp is None:
        import spacy

        # de_core_news_md gives us NER tags (LOC/GPE/DATE) at ~40 MB RAM.
        _nlp = spacy.load("de_core_news_md")
        logger.info("spaCy model 'de_core_news_md' loaded for query parsing.")
    return _nlp


# ---------------------------------------------------------------------------
# Date parsing
# ---------------------------------------------------------------------------

# Year ranges we want to recognise explicitly because dateparser does not
# treat "2004-2017" / "von 2004 bis 2017" as a span.
_YEAR_RANGE_PATTERNS = [
    re.compile(r"\bvon\s+(\d{4})\s+bis\s+(\d{4})\b", re.IGNORECASE),
    re.compile(r"\bzwischen\s+(\d{4})\s+und\s+(\d{4})\b", re.IGNORECASE),
    re.compile(r"\b(\d{4})\s*[-–—]\s*(\d{4})\b"),
    re.compile(r"\b(\d{4})\s+bis\s+(\d{4})\b", re.IGNORECASE),
]

# German season → (start_month, start_day, end_month, end_day)
_SEASONS = {
    "frühling": (3, 1, 5, 31),
    "fruehling": (3, 1, 5, 31),
    "sommer": (6, 1, 8, 31),
    "herbst": (9, 1, 11, 30),
    "winter": (12, 1, 2, 28),
}

_SEASON_RX = re.compile(
    r"\b(frühling|fruehling|sommer|herbst|winter)(?:\s+(\d{4}))?\b",
    re.IGNORECASE,
)


def _extract_year_range(text: str) -> tuple[Optional[datetime], Optional[datetime], str]:
    """Return (from, to, remaining_text) for explicit year ranges."""
    for pattern in _YEAR_RANGE_PATTERNS:
        m = pattern.search(text)
        if m:
            y1, y2 = int(m.group(1)), int(m.group(2))
            if y1 > y2:
                y1, y2 = y2, y1
            from_dt = datetime(y1, 1, 1, 0, 0, 0)
            to_dt = datetime(y2, 12, 31, 23, 59, 59)
            cleaned = (text[: m.start()] + " " + text[m.end():]).strip()
            return from_dt, to_dt, cleaned
    return None, None, text


def _extract_season(text: str) -> tuple[Optional[datetime], Optional[datetime], str]:
    m = _SEASON_RX.search(text)
    if not m:
        return None, None, text
    season = m.group(1).lower()
    year = int(m.group(2)) if m.group(2) else datetime.now().year
    sm, sd, em, ed = _SEASONS[season]
    if season == "winter":
        # Dec of `year` through Feb of `year + 1`
        from_dt = datetime(year, sm, sd, 0, 0, 0)
        to_dt = datetime(year + 1, em, 28, 23, 59, 59)
    else:
        from_dt = datetime(year, sm, sd, 0, 0, 0)
        to_dt = datetime(year, em, ed, 23, 59, 59)
    cleaned = (text[: m.start()] + " " + text[m.end():]).strip()
    return from_dt, to_dt, cleaned


def _extract_dateparser_dates(
    text: str,
) -> tuple[Optional[datetime], Optional[datetime], list[str]]:
    """Use dateparser.search to find any remaining date expressions.

    Returns (from_dt, to_dt, matched_phrases) so the caller can strip the
    phrases from the semantic query.
    """
    try:
        from dateparser.search import search_dates
    except Exception:  # pragma: no cover – import guarded for safety
        logger.warning("dateparser not available; skipping relative-date extraction")
        return None, None, []

    results = search_dates(
        text,
        languages=["de"],
        settings={
            "PREFER_DATES_FROM": "past",
            "RETURN_AS_TIMEZONE_AWARE": False,
        },
    )
    if not results:
        return None, None, []

    matched_phrases = [phrase for phrase, _ in results]
    dates = [dt for _, dt in results]

    if len(dates) >= 2:
        from_dt, to_dt = min(dates), max(dates)
        # Expand to full days
        from_dt = from_dt.replace(hour=0, minute=0, second=0, microsecond=0)
        to_dt = to_dt.replace(hour=23, minute=59, second=59, microsecond=0)
        return from_dt, to_dt, matched_phrases

    # Single hit → treat as a single-day window unless it's clearly a year.
    dt = dates[0]
    phrase = matched_phrases[0]
    if re.fullmatch(r"\s*\d{4}\s*", phrase):
        year = int(phrase.strip())
        return (
            datetime(year, 1, 1, 0, 0, 0),
            datetime(year, 12, 31, 23, 59, 59),
            matched_phrases,
        )
    if re.fullmatch(r"\s*\d{1,2}[./-]\d{4}\s*", phrase):
        # "03/2019" → entire month
        from_dt = dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        # last day of month
        if from_dt.month == 12:
            next_month = from_dt.replace(year=from_dt.year + 1, month=1)
        else:
            next_month = from_dt.replace(month=from_dt.month + 1)
        to_dt = next_month.replace(hour=0, minute=0, second=0, microsecond=0)
        return from_dt, to_dt, matched_phrases

    # Default: full day around the parsed date
    from_dt = dt.replace(hour=0, minute=0, second=0, microsecond=0)
    to_dt = dt.replace(hour=23, minute=59, second=59, microsecond=0)
    return from_dt, to_dt, matched_phrases


# ---------------------------------------------------------------------------
# Location extraction (spaCy NER)
# ---------------------------------------------------------------------------

# Words that look like proper nouns to spaCy but are useless as location filters.
_LOCATION_BLOCKLIST = {
    "deutschland",  # too coarse to be a useful filter for most users; keep
                    # commented out if you want to drop it. Leaving it in for now.
}


def _extract_location(doc, text: str) -> tuple[Optional[str], list[tuple[int, int]]]:
    """Return (location, ent_spans) where ent_spans are char ranges to strip."""
    spans: list[tuple[int, int]] = []
    candidates: list[str] = []
    for ent in doc.ents:
        if ent.label_ in ("LOC", "GPE"):
            value = ent.text.strip()
            if not value:
                continue
            if value.lower() in _LOCATION_BLOCKLIST:
                spans.append((ent.start_char, ent.end_char))
                continue
            candidates.append(value)
            spans.append((ent.start_char, ent.end_char))

    if not candidates:
        return None, spans

    # Pick the longest candidate – usually the most specific (e.g. "München"
    # over "Bayern" if both appear). Could be extended to return all.
    location = max(candidates, key=len)
    return location, spans


def _strip_spans(text: str, spans: list[tuple[int, int]]) -> str:
    """Remove character ranges from `text`, collapsing whitespace."""
    if not spans:
        return text
    # Sort descending so we can splice without shifting earlier indices.
    for start, end in sorted(spans, key=lambda s: s[0], reverse=True):
        text = text[:start] + " " + text[end:]
    return re.sub(r"\s{2,}", " ", text).strip()


def _strip_phrases(text: str, phrases: list[str]) -> str:
    """Remove literal phrases from `text` (case-insensitive)."""
    for phrase in phrases:
        if not phrase.strip():
            continue
        text = re.sub(re.escape(phrase), " ", text, flags=re.IGNORECASE)
    return re.sub(r"\s{2,}", " ", text).strip()


# Connector words left over after extraction that add no semantic value for CLIP.
_CLIP_STOPWORDS_RX = re.compile(
    r"\b(von|bis|und|im|in|aus|bei|der|die|das|dem|den|nahe|zwischen|jahr|monat|an|am|um|seit|zum|zur)\b",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def parse_query(query: str) -> dict:
    """Parse a German natural-language photo search query.

    Returns a dict with keys matching the TypeScript `ParsedQuery` interface
    (fields are `null` when not detected so JSON serialisation stays
    consistent across calls):
        - semantic_query: str   (always present, possibly empty)
        - location:       str | None
        - from_date:      ISO 8601 str | None
        - to_date:        ISO 8601 str | None
    """
    if not query or not query.strip():
        return {
            "semantic_query": "",
            "location": None,
            "from_date": None,
            "to_date": None,
        }

    raw = query.strip()

    # 1. Year ranges (most specific date pattern)
    from_dt, to_dt, remaining = _extract_year_range(raw)

    # 2. Seasons
    if from_dt is None:
        from_dt, to_dt, remaining = _extract_season(remaining)

    # 3. Locations via spaCy NER (run on the full original text for best NER
    #    quality, then strip spans afterwards).
    nlp = _get_nlp()
    doc = nlp(raw)
    location, ent_spans = _extract_location(doc, raw)
    # Apply ent-span removal to the *current* `remaining` (which may have had
    # year ranges stripped). We re-detect spans in `remaining` by string match
    # to avoid index drift after the earlier strip.
    if location:
        remaining = _strip_phrases(remaining, [doc.text[s:e] for s, e in ent_spans])

    # 4. Free-form dates via dateparser (catches "letzten Sommer", "vor 2 Jahren",
    #    "März 2019", "2019" – everything the regex parser handled plus more).
    if from_dt is None:
        df, dt, phrases = _extract_dateparser_dates(remaining)
        if df is not None:
            from_dt, to_dt = df, dt
            remaining = _strip_phrases(remaining, phrases)

    # 5. Clean leftover stopwords for CLIP
    semantic = _CLIP_STOPWORDS_RX.sub(" ", remaining)
    semantic = re.sub(r"\s{2,}", " ", semantic).strip()

    return {
        "semantic_query": semantic,
        "location": location,
        "from_date": from_dt.isoformat() if from_dt else None,
        "to_date": to_dt.isoformat() if to_dt else None,
    }
