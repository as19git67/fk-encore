#!/usr/bin/env python3
"""Cloud-LLM Audit: Claude klassifiziert eine Stichprobe und wird mit dem lokalen Klassifikator verglichen.

READ-ONLY auf der DB. Schreibt einen Disagreement-Report nach
scripts/taxonomy/out/cloud_audit.md und die bestätigten Gold-Labels nach
scripts/taxonomy/out/cloud_audit_gold.json.

Prüft zwei unabhängige Achsen gegen den lokalen Klassifikator:
  1. Kategorie (category_slug) — wie schon bisher.
  2. Steuerrelevanz (tax_relevant / tax_year / tax_sections) — NEU. Claude
     bekommt exakt dieselbe STEUER-ERKENNUNG-Anleitung wie der lokale
     Klassifikator: der Prompt wird zur Laufzeit direkt aus
     documents/classify-prompts.ts gelesen (kein dupliziertes, driftendes
     Copy), damit der Vergleich die Modellqualität misst, nicht Prompt-
     Unterschiede.

Die Stichprobe zieht gezielt aus den aktuell auffälligen bzw. vorher toten
Steuer-Sektionen (AUDIT_TAX_FOCUS_SECTIONS), weil genau dort ein Diagnose-Lauf
einen plötzlichen, überproportionalen Anstieg von tax_relevant zeigte, der
verifiziert werden soll (siehe scripts/taxonomy/out/diagnose.md §5).

Voraussetzungen:
  pip3 install -r scripts/taxonomy/requirements.txt anthropic
  export ANTHROPIC_API_KEY=sk-ant-...

Aufruf:
  python3 scripts/taxonomy/cloud_audit.py
  AUDIT_SAMPLE=100 python3 scripts/taxonomy/cloud_audit.py        # kleinere Kategorie-Stichprobe
  AUDIT_TAX_SAMPLE=50 python3 scripts/taxonomy/cloud_audit.py     # kleinere Steuer-Stichprobe
  AUDIT_TAX_FOCUS_SECTIONS=anlage-g,anlage-kind python3 scripts/taxonomy/cloud_audit.py
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import signal
import sys
import time
from pathlib import Path

try:
    import anthropic
except ImportError:
    print("[cloud_audit] FEHLER: 'anthropic' nicht installiert.\n"
          "  pip3 install anthropic", file=sys.stderr)
    sys.exit(1)

import _common as c

OUT = c.OUT_DIR
_P = c.today_prefix()
SAMPLE_SIZE = int(os.environ.get("AUDIT_SAMPLE", "300"))
TAX_SAMPLE_SIZE = int(os.environ.get("AUDIT_TAX_SAMPLE", "100"))
BATCH_SIZE = 5
CLAUDE_MODEL = os.environ.get("AUDIT_MODEL", "claude-opus-4-8")
DRY_RUN = os.environ.get("AUDIT_DRY_RUN", "").lower() in ("1", "true", "yes")
# The SDK already retries 429/5xx/connection errors with exponential backoff and
# respects Retry-After; raise the ceiling so a busy minute doesn't lose docs.
MAX_RETRIES = int(os.environ.get("AUDIT_MAX_RETRIES", "8"))
# Optional fixed delay (seconds) between requests to stay under the per-minute
# rate limit proactively. 0 = as fast as the SDK allows.
REQUEST_DELAY = float(os.environ.get("AUDIT_REQUEST_DELAY", "0"))
# Output ceiling per document. Generous on purpose: models from Opus 5 onwards
# run adaptive thinking by default (Opus 4.8 and 4.7 did not), and thinking
# tokens are drawn from this same budget. At the previous 16k the answer was
# routinely cut off mid-JSON — a tenth of the 2026-08-23 sample failed that way,
# each one surfacing only as an opaque parse error.
MAX_OUTPUT_TOKENS = int(os.environ.get("AUDIT_MAX_TOKENS", "32000"))

# Name of the checkpoint that lets an interrupted run pick up where it stopped
# (see the checkpoint helpers in _common.py). AUDIT_RESUME=0 forces a fresh
# sample even when a usable checkpoint is lying around.
CHECKPOINT_NAME = "cloud_audit_checkpoint"
RESUME_ENABLED = os.environ.get("AUDIT_RESUME", "1").lower() not in ("0", "false", "no")
# Bump when the checkpoint's own layout changes so old files are not resumed
# into code that no longer understands them.
_CHECKPOINT_VERSION = 1

# Sektionen, die in der letzten Diagnose auffällig waren: vorher tot
# (anlage-euer, anlage-kind, mantelbogen, werbungskosten-v) oder plötzlich der
# mit Abstand größte Block (aussergewoehnliche, anlage-av). Bewusst als Env-Var
# überschreibbar, weil sich der "aktuell auffällige" Satz von Sektionen mit
# jedem Diagnose-Lauf ändern kann.
_DEFAULT_TAX_FOCUS = [
    "aussergewoehnliche", "anlage-av", "anlage-euer", "anlage-kind",
    "mantelbogen", "werbungskosten-v",
]
TAX_FOCUS_SECTIONS = [
    s.strip() for s in os.environ.get(
        "AUDIT_TAX_FOCUS_SECTIONS", ",".join(_DEFAULT_TAX_FOCUS)
    ).split(",") if s.strip()
]

_VALID_TAX_SLUGS = {s["slug"] for s in c.tax_sections()}

# ── Taxonomie aus dem TS-Quelltext lesen ──────────────────────────────────────

def _load_taxonomy_outline() -> str:
    """Parse taxonomy.ts into the same indented outline the local LLM sees."""
    text = (c.REPO_ROOT / "documents" / "taxonomy.ts").read_text("utf8")

    # Extract slug, name, hint via one combined regex (order as authored).
    entries: list[dict] = []
    for m in re.finditer(
        r'\{\s*slug:\s*"([^"]+)",\s*name:\s*"([^"]+)"(?:,\s*(?:icon:\s*"[^"]*",?\s*)?(?:hint:\s*"((?:[^"\\]|\\.)*)")?)?\s*',
        text,
    ):
        entries.append({
            "slug": m.group(1),
            "name": m.group(2),
            "hint": (m.group(3) or "").replace('\\"', '"') if m.group(3) else "",
        })

    lines: list[str] = []
    for e in entries:
        slug = e["slug"]
        depth = slug.count("-")
        indent = "  " * depth
        hint = f" — {e['hint']}" if e["hint"] else ""
        lines.append(f"{indent}- {slug}: {e['name']}{hint}")
    return "\n".join(lines)


# ── Steuer-Sektionen aus dem TS-Quelltext lesen ───────────────────────────────

_TAX_GROUP_LABELS = {
    "einkuenfte": "Einkünfte",
    "abzuege": "Abzüge",
    "bescheid": "Bescheide",
    "rahmen": "Rahmen / Stammdaten",
}
_TAX_GROUP_ORDER = ("einkuenfte", "abzuege", "bescheid", "rahmen")


def _load_tax_sections_outline() -> str:
    """Gruppierte Sektions-Übersicht — spiegelt _tax_sections_outline() aus
    llm-service/main.py, damit Claude dieselbe Sicht wie der lokale Klassifikator bekommt."""
    sections = c.tax_sections_with_hints()
    by_group: dict[str, list[dict]] = {}
    for s in sections:
        by_group.setdefault(s["group"], []).append(s)

    lines: list[str] = []
    seen = set()
    for group in _TAX_GROUP_ORDER:
        if group not in by_group:
            continue
        seen.add(group)
        lines.append(f"[{_TAX_GROUP_LABELS.get(group, group)}]")
        for s in by_group[group]:
            lines.append(f"- {s['slug']}: {s['name']} — {s['hint']}")
    for group, items in by_group.items():
        if group in seen:
            continue
        lines.append(f"[{group}]")
        for s in items:
            lines.append(f"- {s['slug']}: {s['name']} — {s['hint']}")
    return "\n".join(lines)


# ── Stichprobe ziehen ─────────────────────────────────────────────────────────

# Gemeinsame SELECT-Spalten für alle Bucket-Queries: Kategorie- UND
# Steuerfelder, damit jedes Dokument unabhängig von seinem Bucket auf beiden
# Achsen (Kategorie + Steuer) auditiert werden kann.
_BASE_COLUMNS = """
    d.id, d.title, d.sender, d.extracted_text,
    c.slug AS cat_slug, c.name AS cat_name,
    d.classification_confidence AS confidence,
    d.tags_text AS tags,
    d.tax_relevant AS local_tax_relevant,
    d.tax_year AS local_tax_year,
    COALESCE(
      (SELECT array_agg(dts.tax_section || '::' || dts.confidence::text)
       FROM document_tax_sections dts
       WHERE dts.document_id = d.id AND dts.source = 'ai'),
      ARRAY[]::text[]
    ) AS local_tax_sections_raw
"""


def _parse_tax_sections(raw: list[str] | None) -> list[dict]:
    out = []
    for item in raw or []:
        slug, _, conf = item.partition("::")
        try:
            out.append({"slug": slug, "confidence": float(conf)})
        except ValueError:
            out.append({"slug": slug, "confidence": None})
    return out


def _rows_to_docs(cols: list[str], rows: list[tuple]) -> list[dict]:
    docs = []
    for row in rows:
        d = dict(zip(cols, row))
        d["local_tax_sections"] = _parse_tax_sections(d.pop("local_tax_sections_raw", None))
        docs.append(d)
    return docs


def _fetch_documents_by_ids(conn, doc_ids: list[int]) -> list[dict]:
    """Re-read an earlier run's sample, in the order it was drawn.

    A resume cannot re-run `_sample_documents`: three of its four buckets use
    ORDER BY random(), so a second draw would audit a different set of
    documents and the results already paid for would not belong to it. The
    checkpoint therefore stores the ids and this reads exactly those back.
    """
    if not doc_ids:
        return []
    cur = conn.cursor()
    cur.execute(f"""
        SELECT {_BASE_COLUMNS}
        FROM documents d
        JOIN document_categories c ON c.id = d.category_id
        WHERE d.id = ANY(%s)
    """, (doc_ids,))
    cols = [desc[0] for desc in cur.description]
    docs = _rows_to_docs(cols, cur.fetchall())
    cur.close()
    by_id = {d["id"]: d for d in docs}
    # Documents deleted since the run started simply drop out of the sample.
    return [by_id[i] for i in doc_ids if i in by_id]


def _sample_documents(conn) -> list[dict]:
    """Zwei unabhängige Stichproben, zusammengeführt:
      A) Steuer-fokussiert — Dokumente aus AUDIT_TAX_FOCUS_SECTIONS zuerst,
         Rest zufällig aus allen tax_relevant=true Dokumenten (Recall-Check).
      B) Kategorie-fokussiert — unverändert: sonstiges + low-confidence + random.
    `picked_ids` wird über beide Stichproben hinweg geteilt, damit ein
    Dokument nicht doppelt auftaucht (und doppelt Claude-Kosten verursacht).
    """
    cur = conn.cursor()
    picked_ids: set[int] = set()

    # ── A) Steuer-fokussiert ──────────────────────────────────────────────
    focus_count = int(TAX_SAMPLE_SIZE * 0.7)
    random_tax_count = TAX_SAMPLE_SIZE - focus_count

    # documents:document_categories is a 1:1 FK join and the EXISTS subquery
    # below doesn't fan out rows, so plain SELECT (no DISTINCT) already
    # returns at most one row per document — which also lets ORDER BY
    # random() work without the "must appear in SELECT list" restriction
    # DISTINCT would impose.
    tax_focus: list[dict] = []
    if TAX_FOCUS_SECTIONS:
        cur.execute(f"""
            SELECT {_BASE_COLUMNS}
            FROM documents d
            JOIN document_categories c ON c.id = d.category_id
            WHERE d.tax_relevant = true
              AND EXISTS (
                SELECT 1 FROM document_tax_sections dts
                WHERE dts.document_id = d.id AND dts.tax_section = ANY(%s)
              )
            ORDER BY random()
            LIMIT %s
        """, (TAX_FOCUS_SECTIONS, focus_count))
        cols = [desc[0] for desc in cur.description]
        tax_focus = _rows_to_docs(cols, cur.fetchall())
    picked_ids.update(d["id"] for d in tax_focus)

    cur.execute(f"""
        SELECT {_BASE_COLUMNS}
        FROM documents d
        JOIN document_categories c ON c.id = d.category_id
        WHERE d.tax_relevant = true
          AND d.id <> ALL(%s)
        ORDER BY random()
        LIMIT %s
    """, (list(picked_ids) or [-1], random_tax_count * 2))
    cols = [desc[0] for desc in cur.description]
    tax_random = _rows_to_docs(cols, cur.fetchall())[:random_tax_count]
    picked_ids.update(d["id"] for d in tax_random)

    tax_sample = tax_focus + tax_random
    print(f"[cloud_audit] Steuer-Stichprobe: {len(tax_focus)} Fokus-Sektionen "
          f"({', '.join(TAX_FOCUS_SECTIONS) or '—'}) + {len(tax_random)} random "
          f"tax_relevant = {len(tax_sample)}")

    # ── B) Kategorie-fokussiert ──────────────────────────────────────────
    # AUDIT_SAMPLE=0 überspringt die Kategorie-Achse komplett — nützlich, um das
    # (rate-limitierte) API-Budget ganz auf die Steuerprüfung zu legen.
    if SAMPLE_SIZE <= 0:
        cur.close()
        print("[cloud_audit] Kategorie-Stichprobe: übersprungen (AUDIT_SAMPLE=0)")
        print(f"[cloud_audit] Gesamt-Stichprobe (dedupliziert): {len(tax_sample)}")
        return tax_sample

    # sonstiges is capped at min(100, SAMPLE_SIZE); low-conf at min(50, rest).
    sonstiges_limit = min(100, SAMPLE_SIZE)
    cur.execute(f"""
        SELECT {_BASE_COLUMNS}
        FROM documents d
        JOIN document_categories c ON c.id = d.category_id
        WHERE c.slug = 'sonstiges'
          AND d.id <> ALL(%s)
        ORDER BY random()
        LIMIT %s
    """, (list(picked_ids) or [-1], sonstiges_limit))
    cols = [desc[0] for desc in cur.description]
    sonstiges = _rows_to_docs(cols, cur.fetchall())
    picked_ids.update(d["id"] for d in sonstiges)

    low_conf_limit = max(0, min(50, SAMPLE_SIZE - len(sonstiges)))
    low_conf: list[dict] = []
    if low_conf_limit > 0:
        cur.execute(f"""
            SELECT {_BASE_COLUMNS}
            FROM documents d
            JOIN document_categories c ON c.id = d.category_id
            WHERE d.classification_confidence < 0.85
              AND c.slug <> 'sonstiges'
              AND d.id <> ALL(%s)
            ORDER BY d.classification_confidence ASC
            LIMIT %s
        """, (list(picked_ids) or [-1], low_conf_limit))
        low_conf = _rows_to_docs(cols, cur.fetchall())
        picked_ids.update(d["id"] for d in low_conf)

    remaining = SAMPLE_SIZE - len(sonstiges) - len(low_conf)
    if remaining > 0:
        cur.execute(f"""
            SELECT {_BASE_COLUMNS}
            FROM documents d
            JOIN document_categories c ON c.id = d.category_id
            WHERE c.slug <> 'sonstiges'
              AND d.classification_confidence >= 0.85
              AND d.id <> ALL(%s)
            ORDER BY random()
            LIMIT %s
        """, (list(picked_ids) or [-1], remaining))
        random_docs = _rows_to_docs(cols, cur.fetchall())
    else:
        random_docs = []

    cur.close()
    cat_sample = sonstiges + low_conf + random_docs
    print(f"[cloud_audit] Kategorie-Stichprobe: {len(sonstiges)} sonstiges + "
          f"{len(low_conf)} low-conf + {len(random_docs)} random = {len(cat_sample)}")

    all_docs = tax_sample + cat_sample
    print(f"[cloud_audit] Gesamt-Stichprobe (dedupliziert): {len(all_docs)}")
    return all_docs


# ── Anonymisierung ────────────────────────────────────────────────────────────

_TEXT_CAP = 6000  # same cap as llm-service/main.py

def _anonymize_doc(doc: dict, names: list[str]) -> dict:
    """Scrub PII from title, extracted_text, sender; keep sender_type."""
    raw_text = (doc.get("extracted_text") or "")[:_TEXT_CAP]
    return {
        "id": doc["id"],
        "title": c.scrub_names(c.scrub(doc.get("title")), names) or "",
        "text": c.scrub_names(c.scrub(raw_text), names) or "",
        "sender_type": c.sender_type(doc.get("sender")),
        "tags": c.scrub_names(c.scrub(doc.get("tags") or ""), names) or "",
        "local_slug": doc["cat_slug"],
        "local_name": doc["cat_name"],
        "local_confidence": doc.get("confidence"),
        "local_tax_relevant": bool(doc.get("local_tax_relevant")),
        "local_tax_year": doc.get("local_tax_year"),
        "local_tax_sections": doc.get("local_tax_sections") or [],
    }


# ── Claude-Klassifikation ────────────────────────────────────────────────────

_SYSTEM_BASE = """Du bist ein Experte für die Klassifikation privater Haushalts-Dokumente
UND für die deutsche Einkommensteuererklärung. Dir wird ein Dokument gezeigt
(Titel, OCR-extrahierter Text, Absender-Typ, Tags) sowie eine Taxonomie und
eine Liste von Steuer-Sektionen. Beurteile beides unabhängig.

Antworte ausschließlich mit gültigem JSON (ohne Markdown-Fences):
{
  "slug": "der-beste-taxonomie-slug",
  "confidence": 0.0-1.0,
  "reasoning": "kurze Begründung zur Kategorie",
  "tax_relevant": true/false,
  "tax_year": 2024,
  "tax_year_confidence": 0.0-1.0,
  "tax_sections": [{"slug": "anlage-n", "confidence": 0.9}],
  "tax_reasoning": "kurze Begründung zur Steuer-Einordnung"
}

Wenn kein Taxonomie-Slug passt, verwende "sonstiges". Wenn das Dokument nicht
steuerrelevant ist: tax_relevant=false, tax_year=null, tax_sections=[]."""

def _load_prompt_constant(name: str) -> str:
    """Lies eine Prompt-Konstante wortgleich aus documents/classify-prompts.ts.

    So bekommt Claude im Audit exakt dieselbe Anleitung wie der lokale
    Klassifikator — ohne Drift, wenn der Prompt dort weiterentwickelt wird. Der
    Vergleich misst damit Modellqualität, nicht Prompt-Unterschiede.
    """
    text = (c.REPO_ROOT / "documents" / "classify-prompts.ts").read_text("utf8")
    m = re.search(rf"{re.escape(name)}\s*=\s*`(.*?)`", text, re.DOTALL)
    if not m:
        raise RuntimeError(
            f"{name} nicht in documents/classify-prompts.ts gefunden"
        )
    return m.group(1).strip()


_TAX_GUIDANCE = _load_prompt_constant("CLASSIFY_TAX_PROMPT")
# Kategorie-Regeln (spezifischste Kategorie, Abgrenzung der beiden
# Sammelkategorien). Bis 2026-08 bekam nur die Steuer-Hälfte des Prompts diese
# Gleichbehandlung — die Kategorie-Hälfte driftete zwischen Referenz und
# lokalem Modell auseinander, was im Scoreboard als Modellunterschied erschien.
_CATEGORY_RULES = _load_prompt_constant("CLASSIFY_CATEGORY_RULES")


def _build_system(tax_outline: str) -> str:
    return (
        f"{_SYSTEM_BASE}\n{_CATEGORY_RULES}\n{_TAX_GUIDANCE}\n\n"
        f"Steuer-Sektionen (slug: Name — Hinweis):\n{tax_outline}"
    )


# ── Prompt-Caching ────────────────────────────────────────────────────────────
# Der System-Prompt UND die Taxonomie sind für einen ganzen Lauf identisch —
# nur das jeweilige Dokument ändert sich pro Request. Ohne cache_control zahlt
# und rendert Claude beides bei jedem einzelnen Dokument neu; markiert als
# ephemeral (5-Minuten-TTL, verlängert sich bei jedem Cache-Hit) trifft ab dem
# zweiten Request im Lauf ein Cache-Hit, solange die Requests sequenziell
# innerhalb der TTL bleiben (was bei einem einzelnen Lauf immer der Fall ist).
_CACHE_CONTROL = {"type": "ephemeral"}


def _system_blocks(system_text: str) -> list[dict]:
    return [{"type": "text", "text": system_text, "cache_control": _CACHE_CONTROL}]


def _taxonomy_cache_block(taxonomy: str) -> dict:
    """Cacheable Präfix-Block der User-Message: identisch für jedes Dokument
    im Lauf, siehe _CACHE_CONTROL oben. Muss als erster Content-Block der
    Message stehen, damit Claude den kompletten Präfix bis einschließlich
    diesem Block cachen kann."""
    return {"type": "text", "text": f"Taxonomie:\n{taxonomy}\n\n", "cache_control": _CACHE_CONTROL}


def _build_doc_msg(doc: dict) -> str:
    """Der NICHT-cacheable, pro Dokument einzigartige Teil der User-Message."""
    return (
        f"Dokument (ID {doc['id']}):\n"
        f"- Titel: {doc['title']}\n"
        f"- Absender-Typ: {doc['sender_type']}\n"
        f"- Tags: {doc['tags']}\n"
        f"- Text:\n{doc['text']}\n"
    )


def _user_content_blocks(doc: dict, taxonomy: str) -> list[dict]:
    return [_taxonomy_cache_block(taxonomy), {"type": "text", "text": _build_doc_msg(doc)}]


def _build_user_msg(doc: dict, taxonomy: str) -> str:
    """Volltext der User-Message — nur noch für den (nicht an die API
    gesendeten) Dry-Run-Export; der Live-Call nutzt _user_content_blocks."""
    return f"Taxonomie:\n{taxonomy}\n\n{_build_doc_msg(doc)}"


def _clean_claude_tax_sections(raw: object) -> list[dict]:
    """Wie die TS-Validierung in llm-client.ts: nur bekannte Slugs, dedupliziert,
    höchste Confidence pro Slug, absteigend sortiert."""
    if not isinstance(raw, list):
        return []
    by_slug: dict[str, float] = {}
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        slug = str(entry.get("slug", "")).strip().lower()
        if slug not in _VALID_TAX_SLUGS:
            continue
        try:
            conf = float(entry.get("confidence", 0))
        except (TypeError, ValueError):
            conf = 0.0
        conf = max(0.0, min(1.0, conf))
        if slug not in by_slug or conf > by_slug[slug]:
            by_slug[slug] = conf
    return sorted(
        ({"slug": s, "confidence": v} for s, v in by_slug.items()),
        key=lambda x: (-x["confidence"], x["slug"]),
    )


def _is_rate_or_overload(exc: Exception) -> bool:
    """A sustained rate-limit / overload / credit exhaustion that even the
    SDK's retries couldn't ride out. Aborting the run then beats burning the
    rest of the sample on the same wall (and keeps the partial results already
    gathered). 402 = credit/billing limit reached.

    An exhausted credit balance is sometimes reported as 400 invalid_request_error
    rather than 402 — the SDK doesn't retry it and every remaining document would
    otherwise fail the same way, one quiet [!] line at a time. Catch it by message
    text as well as status code."""
    if isinstance(exc, anthropic.RateLimitError):
        return True
    status = getattr(exc, "status_code", None)
    if status in (402, 429, 529, 503):
        return True
    return "credit balance is too low" in str(exc).lower()


class TruncatedResponseError(RuntimeError):
    """The model hit `max_tokens` before finishing its answer.

    Distinct from a malformed answer: the JSON is not wrong, it is cut off. Worth
    retrying (adaptive thinking varies run to run) and worth naming in the report,
    because the fix is to raise `AUDIT_MAX_TOKENS`, not to change the prompt.
    """


class NoJsonInResponseError(ValueError):
    """The response finished normally but contains no `{` at all — not cut off,
    not malformed, just absent (e.g. Claude answered in prose instead of the
    requested JSON schema).

    Subclasses ValueError so it's still caught by every existing
    `except (..., ValueError)` clause; the only change is that the raw text
    travels with it instead of being discarded at the point of failure, since
    a bare "substring not found" gives no way to tell why a document failed.
    """

    def __init__(self, text: str):
        super().__init__("Antwort enthielt kein JSON-Objekt")
        self.text = text


def _error_kind(exc: Exception) -> str:
    """Short, groupable label for why a document produced no verdict."""
    if isinstance(exc, TruncatedResponseError):
        return f"Antwort abgeschnitten (max_tokens={MAX_OUTPUT_TOKENS})"
    if isinstance(exc, NoJsonInResponseError):
        return "Antwort enthielt kein JSON"
    if isinstance(exc, json.JSONDecodeError):
        return "Antwort war kein gültiges JSON"
    if isinstance(exc, anthropic.APIError):
        status = getattr(exc, "status_code", None)
        return f"API-Fehler {status}" if status else f"API-Fehler ({type(exc).__name__})"
    return f"{type(exc).__name__}: {exc}"


def _no_json_snippet(exc: Exception, limit: int = 400) -> str:
    """PII-scrubbed preview of the raw text behind a NoJsonInResponseError, for
    logging next to the opaque "kein JSON" label. Empty string for any other
    exception so call sites can append it unconditionally."""
    if not isinstance(exc, NoJsonInResponseError):
        return ""
    snippet = (c.scrub(exc.text) or "")[:limit].strip()
    return f" — Rohtext: {snippet!r}"


def _request_classification(
    client: anthropic.Anthropic,
    doc: dict,
    taxonomy: str,
    system: str,
) -> dict:
    """One Claude call for one document; returns the parsed JSON answer.

    Streams rather than blocking: with a `max_tokens` this size a non-streaming
    request can outlive the SDK's HTTP timeout.
    """
    with client.messages.stream(
        model=CLAUDE_MODEL,
        max_tokens=MAX_OUTPUT_TOKENS,
        system=_system_blocks(system),
        messages=[{"role": "user", "content": _user_content_blocks(doc, taxonomy)}],
    ) as stream:
        resp = stream.get_final_message()

    # Check this before looking for the text block: when thinking exhausts the
    # budget there is no text block at all, and "no text block" would be a
    # thoroughly misleading way to report "the answer did not fit".
    if resp.stop_reason == "max_tokens":
        raise TruncatedResponseError(
            f"Antwort bei max_tokens={MAX_OUTPUT_TOKENS} abgeschnitten "
            f"(output_tokens={resp.usage.output_tokens}) — AUDIT_MAX_TOKENS erhöhen"
        )

    text_block = next(
        (b for b in resp.content if getattr(b, "type", None) == "text"),
        None,
    )
    if text_block is None:
        raise ValueError(f"no text block in response (stop_reason={resp.stop_reason})")
    text = text_block.text.strip()
    # Strip markdown fences
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    if "{" not in text:
        raise NoJsonInResponseError(text)
    # raw_decode stops after the first complete JSON object
    idx = text.index("{")
    parsed, _ = json.JSONDecoder().raw_decode(text, idx)
    return parsed


def _classify_one(
    client: anthropic.Anthropic,
    doc: dict,
    taxonomy: str,
    system: str,
) -> dict:
    """As `_request_classification`, but retries once on a truncated or
    unparseable answer. Both are non-deterministic — thinking depth varies per
    run — so a second attempt usually succeeds where the first did not. API
    errors are not retried here: the SDK already handles the retryable ones and
    a rate limit has to reach the caller to abort the run.
    """
    last: Exception
    for attempt in (1, 2):
        try:
            return _request_classification(client, doc, taxonomy, system)
        except (TruncatedResponseError, json.JSONDecodeError, ValueError) as e:
            last = e
            if attempt == 1:
                print(f"      … Versuch 1 fehlgeschlagen ({e}){_no_json_snippet(e)} — wiederhole")
                time.sleep(2)
    raise last


# ── Checkpoint / geordnetes Herunterfahren ───────────────────────────────────

_shutdown_requested = False


def _install_shutdown_handler() -> None:
    """Turn SIGTERM/SIGINT into a request to stop between documents.

    A container stop (deploy, watchtower update, `docker compose down`) arrives
    as SIGTERM. Without a handler Python dies immediately, which is survivable
    — every finished document is already fsynced to the checkpoint — but it
    also kills the run mid-request and wastes that document's tokens. Stopping
    between documents costs at most one in-flight request instead.

    Deliberately does NOT clear the checkpoint: a signal cannot tell us whether
    the operator cancelled or the host merely restarted, so the run stays
    resumable and only an explicit cancel through the sidecar discards it.
    """
    def handler(signum, _frame):
        global _shutdown_requested
        if _shutdown_requested:
            return  # second signal: let the default behaviour take over
        _shutdown_requested = True
        print(
            f"\n[cloud_audit] Signal {signum} empfangen — beende nach dem "
            f"laufenden Dokument. Der Checkpoint bleibt erhalten, ein neuer "
            f"Lauf macht dort weiter.",
            file=sys.stderr,
        )

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, handler)
        except (ValueError, OSError):
            pass  # not on the main thread — nothing to install


def _run_fingerprint() -> str:
    """Identity of a run's parameters.

    A checkpoint may only be resumed by a run that would have drawn the same
    kind of sample. Changing the model or the sample sizes makes the stored
    results answer a different question, so the fingerprint changes with them
    and the old checkpoint is discarded rather than silently mixed in.
    """
    payload = json.dumps({
        "version": _CHECKPOINT_VERSION,
        "model": CLAUDE_MODEL,
        "sample": SAMPLE_SIZE,
        "tax_sample": TAX_SAMPLE_SIZE,
        "focus_sections": sorted(TAX_FOCUS_SECTIONS),
    }, sort_keys=True)
    return hashlib.sha256(payload.encode("utf8")).hexdigest()[:16]


def _classify_batch(
    client: anthropic.Anthropic,
    docs: list[dict],
    taxonomy: str,
    tax_outline: str,
    on_result=None,
) -> tuple[list[dict], bool]:
    """Classify a batch of documents via Claude. Returns (results, aborted).

    `aborted` is True when a sustained rate-limit/overload made us stop early;
    the caller keeps the partial results and skips the rest of the run.

    `on_result` is called with each finished document — success or ERROR row
    alike — before the next request starts. That is what makes a run
    resumable: it is the only moment at which we know a document is done and
    have not yet risked anything on the next one.
    """
    system = _build_system(tax_outline)
    results: list[dict] = []
    batch_total = len(docs)
    for di, doc in enumerate(docs, 1):
        if _shutdown_requested:
            return results, False
        print(f"    [{di}/{batch_total}] Dok {doc['id']} — sende an Claude …")
        base = {
            "doc_id": doc["id"],
            "local_slug": doc["local_slug"],
            "local_name": doc["local_name"],
            "local_confidence": doc["local_confidence"],
            "local_tax_relevant": doc["local_tax_relevant"],
            "local_tax_year": doc["local_tax_year"],
            "local_tax_sections": doc["local_tax_sections"],
            "title": doc["title"],
            "text": doc["text"][:1500],
            "sender_type": doc["sender_type"],
        }
        try:
            parsed = _classify_one(client, doc, taxonomy, system)
            claude_slug = parsed.get("slug", "?")
            match = "✓" if claude_slug == doc["local_slug"] else f"✗ (Lokal: {doc['local_slug']})"
            print(f"      → {claude_slug} {match}")
            results.append({
                **base,
                "claude_slug": claude_slug,
                "claude_confidence": parsed.get("confidence", 0),
                "reasoning": parsed.get("reasoning", ""),
                "claude_tax_relevant": bool(parsed.get("tax_relevant", False)),
                "claude_tax_year": parsed.get("tax_year"),
                "claude_tax_sections": _clean_claude_tax_sections(parsed.get("tax_sections")),
                "tax_reasoning": parsed.get("tax_reasoning", ""),
            })
        except (
            TruncatedResponseError,
            json.JSONDecodeError,
            anthropic.APIError,
            KeyError,
            ValueError,
        ) as e:
            if _is_rate_or_overload(e):
                print(
                    f"  [!] Rate-Limit/Guthaben bei Dok {doc['id']} — Lauf wird "
                    f"abgebrochen, Teilergebnis bleibt erhalten: {e}",
                    file=sys.stderr,
                )
                return results, True
            print(f"  [!] Dok {doc['id']}: {e}{_no_json_snippet(e)}", file=sys.stderr)
            results.append({
                **base,
                "claude_slug": "ERROR",
                # Grouped in the report so a run that loses documents says *why*
                # rather than only how many.
                "error_kind": _error_kind(e),
                "claude_confidence": 0,
                "reasoning": str(e),
                "claude_tax_relevant": None,
                "claude_tax_year": None,
                "claude_tax_sections": [],
                "tax_reasoning": "",
            })
        if on_result is not None:
            on_result(results[-1])
        if REQUEST_DELAY > 0:
            time.sleep(REQUEST_DELAY)
    return results, False


# ── Report ────────────────────────────────────────────────────────────────────

def _generate_report(results: list[dict]) -> tuple[str, list[dict]]:
    """Generate markdown report + gold-set JSON."""
    md = c.Md()
    md("# Cloud-Audit: Claude vs. lokaler Klassifikator — Kategorie & Steuer")
    md()
    md(f"_Erzeugt: {time.strftime('%Y-%m-%dT%H:%M:%S')} — "
       f"Modell: {CLAUDE_MODEL}, Stichprobe: {len(results)}_")
    md()

    total = len(results)
    errors = [r for r in results if r["claude_slug"] == "ERROR"]
    valid = [r for r in results if r["claude_slug"] != "ERROR"]
    agree = [r for r in valid if r["claude_slug"] == r["local_slug"]]
    disagree = [r for r in valid if r["claude_slug"] != r["local_slug"]]

    md("## 1. Übersicht")
    md()
    md.table(["Kennzahl", "Wert"], [
        ["Dokumente gesamt", total],
        ["API-Fehler", len(errors)],
        ["Kategorie-Übereinstimmung", f"{len(agree)} ({100*len(agree)/max(1,len(valid)):.1f}%)"],
        ["Kategorie-Disagreement", f"{len(disagree)} ({100*len(disagree)/max(1,len(valid)):.1f}%)"],
    ])

    # Errors are documents Claude never judged — they silently shrink the sample
    # every percentage above is computed over, so name the reasons rather than
    # leaving a bare count.
    if errors:
        by_kind: dict[str, int] = {}
        for r in errors:
            by_kind[r.get("error_kind") or "unbekannt"] = (
                by_kind.get(r.get("error_kind") or "unbekannt", 0) + 1
            )
        md("### 1a. Fehlerursachen")
        md()
        md(f"_{len(errors)} von {total} Dokumenten ohne Claude-Urteil — die Quoten oben "
           f"beziehen sich auf die verbleibenden {len(valid)}._")
        md()
        md.table(
            ["Ursache", "Dokumente"],
            sorted(by_kind.items(), key=lambda kv: -kv[1]),
        )

    # Disagreement by category
    md("## 2. Kategorie-Disagreements nach lokaler Kategorie")
    md()
    by_local: dict[str, list[dict]] = {}
    for r in disagree:
        by_local.setdefault(r["local_slug"], []).append(r)
    rows = sorted(by_local.items(), key=lambda x: -len(x[1]))
    md.table(["Lokale Kategorie", "Fälle", "Claude-Vorschläge (Top 3)"], [
        [
            slug,
            len(items),
            ", ".join(f"{s} ({n}×)" for s, n in _top_n(
                [r["claude_slug"] for r in items], 3
            )),
        ]
        for slug, items in rows
    ])

    # Detailed disagreement list
    md("## 3. Alle Kategorie-Disagreements (Details)")
    md()
    md.table(
        ["Dok-ID", "Titel", "Absender-Typ", "Lokal", "Claude", "Begründung"],
        [
            [
                r["doc_id"],
                (r["title"] or "")[:50],
                r["sender_type"],
                r["local_slug"],
                r["claude_slug"],
                (r["reasoning"] or "")[:80],
            ]
            for r in sorted(disagree, key=lambda x: x["local_slug"])
        ],
    )

    # Agreement stats by category
    md("## 4. Kategorie-Übereinstimmungsrate je Kategorie")
    md()
    all_by_cat: dict[str, dict] = {}
    for r in valid:
        cat = r["local_slug"]
        if cat not in all_by_cat:
            all_by_cat[cat] = {"total": 0, "agree": 0}
        all_by_cat[cat]["total"] += 1
        if r["claude_slug"] == r["local_slug"]:
            all_by_cat[cat]["agree"] += 1
    md.table(
        ["Kategorie", "Gesamt", "Übereinstimmung", "Rate"],
        sorted(
            [
                [cat, d["total"], d["agree"], f"{100*d['agree']/d['total']:.0f}%"]
                for cat, d in all_by_cat.items()
            ],
            key=lambda x: -x[1],
        ),
    )

    # ── 5. Steuer-Übereinstimmung (NEU) ──────────────────────────────────
    tax_valid = [r for r in valid if r["claude_tax_relevant"] is not None]
    md("## 5. Steuer-Übereinstimmung (tax_relevant)")
    md()
    md(f"> Fokus-Sektionen dieser Stichprobe: "
       f"{', '.join(TAX_FOCUS_SECTIONS) or '—'} "
       f"(via `AUDIT_TAX_FOCUS_SECTIONS` einstellbar).")
    md()

    local_true = [r for r in tax_valid if r["local_tax_relevant"]]
    local_false = [r for r in tax_valid if not r["local_tax_relevant"]]
    tp = sum(1 for r in local_true if r["claude_tax_relevant"])  # lokal true, Claude true
    fp = sum(1 for r in local_true if not r["claude_tax_relevant"])  # lokal true, Claude false
    fn = sum(1 for r in local_false if r["claude_tax_relevant"])  # lokal false, Claude true
    tn = sum(1 for r in local_false if not r["claude_tax_relevant"])

    md.table(["", "Claude: steuerrelevant", "Claude: nicht steuerrelevant"], [
        ["Lokal: steuerrelevant", tp, f"**{fp}**  ← mögliche False Positives"],
        ["Lokal: nicht steuerrelevant", f"{fn}  ← mögliche False Negatives", tn],
    ])
    md()
    if local_true:
        md(f"**Von {len(local_true)} lokal als steuerrelevant markierten Dokumenten "
           f"bestätigt Claude {tp} ({100*tp/len(local_true):.1f}%).** "
           f"{fp} ({100*fp/len(local_true):.1f}%) hält Claude für NICHT steuerrelevant.")
        md()

    # Per-section breakdown: for every locally-assigned section, does Claude's own
    # tax_sections list for the same doc contain the same slug?
    md("### 5a. Bestätigungsrate je lokaler Steuer-Sektion")
    md()
    per_section: dict[str, dict] = {}
    for r in tax_valid:
        claude_slugs = {s["slug"] for s in r["claude_tax_sections"]}
        for qs in r["local_tax_sections"]:
            slug = qs["slug"]
            stat = per_section.setdefault(slug, {"total": 0, "confirmed": 0, "rejected": 0, "reassigned": 0})
            stat["total"] += 1
            if slug in claude_slugs:
                stat["confirmed"] += 1
            elif not r["claude_tax_relevant"]:
                stat["rejected"] += 1
            else:
                stat["reassigned"] += 1
    md.table(
        ["Sektion", "Dok. (Lokal)", "Bestätigt", "Rate", "Von Claude verworfen", "Claude anderer Meinung"],
        sorted(
            [
                [slug, s["total"], s["confirmed"], f"{100*s['confirmed']/s['total']:.0f}%",
                 s["rejected"], s["reassigned"]]
                for slug, s in per_section.items()
            ],
            key=lambda x: -x[1],
        ),
    )

    # Detailed disagreement list — the actual false-positive candidates.
    md()
    md("### 5b. Steuer-Disagreements (Details)")
    md()
    tax_disagree = [r for r in tax_valid if r["local_tax_relevant"] != r["claude_tax_relevant"]]
    md.table(
        ["Dok-ID", "Titel", "Absender-Typ", "Lokale Sektionen", "Claude", "Begründung"],
        [
            [
                r["doc_id"],
                (r["title"] or "")[:45],
                r["sender_type"],
                ", ".join(s["slug"] for s in r["local_tax_sections"]) or "—",
                "steuerrelevant: " + ", ".join(s["slug"] for s in r["claude_tax_sections"])
                if r["claude_tax_relevant"] else "NICHT steuerrelevant",
                (r["tax_reasoning"] or "")[:80],
            ]
            for r in sorted(
                tax_disagree,
                key=lambda x: (not x["local_tax_relevant"], x["local_slug"]),
            )
        ],
    )

    # Gold set: documents where Claude and the local classifier agree on category. Carries tax
    # fields too whenever Claude and the local classifier also agree on tax_relevant, so the
    # same run can grow both the category- and the steuer-Gold-Set.
    gold = []
    for r in agree:
        entry = {"doc_id": r["doc_id"], "slug": r["claude_slug"], "confidence": r["claude_confidence"]}
        if r["claude_tax_relevant"] is not None and r["local_tax_relevant"] == r["claude_tax_relevant"]:
            entry["tax_relevant"] = r["claude_tax_relevant"]
            entry["tax_sections"] = r["claude_tax_sections"]
        gold.append(entry)

    md()
    md("---")
    md()
    md(f"_Gold-Set: {len(gold)} Dokumente, bei denen Claude und der lokale Klassifikator bei der Kategorie "
       f"übereinstimmen ({sum(1 for g in gold if 'tax_relevant' in g)} davon auch bei der "
       f"Steuerrelevanz) → `cloud_audit_gold.json`_")

    return "\n".join(md.lines), gold


def _top_n(items: list[str], n: int) -> list[tuple[str, int]]:
    counts: dict[str, int] = {}
    for x in items:
        counts[x] = counts.get(x, 0) + 1
    return sorted(counts.items(), key=lambda x: -x[1])[:n]


# ── Main ──────────────────────────────────────────────────────────────────────

def _write_dry_run(anon_docs: list[dict], taxonomy: str, tax_outline: str) -> None:
    """Write the exact prompts that would be sent to Claude, for review."""
    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / f"{_P}cloud_audit_dry_run.jsonl"
    system = _build_system(tax_outline)
    with open(out_path, "w", encoding="utf8") as f:
        for doc in anon_docs:
            f.write(json.dumps({
                "doc_id": doc["id"],
                "system": system,
                "user_message": _build_user_msg(doc, taxonomy),
                "local_slug": doc["local_slug"],
                "local_name": doc["local_name"],
                "local_tax_relevant": doc["local_tax_relevant"],
                "local_tax_sections": doc["local_tax_sections"],
            }, ensure_ascii=False) + "\n")
    print(f"\n[cloud_audit] DRY RUN — {len(anon_docs)} Prompts geschrieben:")
    print(f"  {out_path.relative_to(c.REPO_ROOT)}")
    print(f"  Bitte prüfen, ob Anonymisierung ausreichend ist.")
    print(f"  Danach ohne AUDIT_DRY_RUN erneut starten.")


def _resume_or_sample(conn) -> tuple[list[dict], list[dict], bool]:
    """(already classified, still to classify, resumed?).

    Resumes an interrupted run when the checkpoint on disk was written by a run
    with the same parameters; otherwise draws a fresh sample and starts a new
    checkpoint.
    """
    stored = c.checkpoint_load(CHECKPOINT_NAME) if RESUME_ENABLED else None
    if stored is not None:
        meta, done_results = stored
        fingerprint = _run_fingerprint()
        doc_ids = [int(i) for i in meta.get("doc_ids") or []]
        if meta.get("fingerprint") != fingerprint:
            print(
                "[cloud_audit] Checkpoint gehört zu anderen Lauf-Parametern "
                "(Modell/Stichprobengröße/Fokus-Sektionen) — wird verworfen.",
                file=sys.stderr,
            )
        elif not doc_ids:
            print("[cloud_audit] Checkpoint ohne Stichprobe — wird verworfen.", file=sys.stderr)
        else:
            docs = _fetch_documents_by_ids(conn, doc_ids)
            done_ids = {r.get("doc_id") for r in done_results}
            remaining = [d for d in docs if d["id"] not in done_ids]
            missing = len(doc_ids) - len(docs)
            print(
                f"[cloud_audit] Setze unterbrochenen Lauf fort: "
                f"{len(done_results)}/{len(doc_ids)} Dokumente bereits klassifiziert, "
                f"{len(remaining)} offen."
                + (f" {missing} Dokument(e) existieren nicht mehr." if missing else "")
            )
            return done_results, remaining, True
    elif not RESUME_ENABLED and c.checkpoint_paths(CHECKPOINT_NAME)[0].is_file():
        print("[cloud_audit] AUDIT_RESUME=0 — vorhandener Checkpoint wird ignoriert.")

    print("[cloud_audit] Wähle Stichprobe aus …")
    docs = _sample_documents(conn)
    if docs:
        c.checkpoint_begin(CHECKPOINT_NAME, {
            "fingerprint": _run_fingerprint(),
            "model": CLAUDE_MODEL,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "doc_ids": [d["id"] for d in docs],
        })
    return [], docs, False


def main() -> None:
    print(f"[cloud_audit] Modell: {CLAUDE_MODEL}, Kategorie-Stichprobe: {SAMPLE_SIZE}, "
          f"Steuer-Stichprobe: {TAX_SAMPLE_SIZE}")
    if DRY_RUN:
        print(f"[cloud_audit] *** DRY RUN — nichts wird an die API gesendet ***")
    print(f"[cloud_audit] DB: {c.safe_dsn()}")

    print("[cloud_audit] Verbinde mit Datenbank …")
    conn = c.connect()
    print("[cloud_audit] Lade Namen für Anonymisierung …")
    names = c.subject_person_names(conn)
    print(f"[cloud_audit] {len(names)} Namen geladen")
    print("[cloud_audit] Lade Taxonomie …")
    taxonomy = _load_taxonomy_outline()
    tax_outline = _load_tax_sections_outline()

    # A dry run sends nothing and costs nothing, so it neither resumes an
    # earlier run nor leaves a checkpoint behind for the next one.
    done_results: list[dict] = []
    resumed = False
    if not DRY_RUN:
        done_results, docs, resumed = _resume_or_sample(conn)
    else:
        print("[cloud_audit] Wähle Stichprobe aus …")
        docs = _sample_documents(conn)
    conn.close()

    if not docs and not done_results:
        print("[cloud_audit] Keine Dokumente gefunden.", file=sys.stderr)
        sys.exit(1)

    print(f"[cloud_audit] Anonymisiere {len(docs)} Dokumente …")
    anon_docs = [_anonymize_doc(d, names) for d in docs]

    if DRY_RUN:
        _write_dry_run(anon_docs, taxonomy, tax_outline)
        return

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("[cloud_audit] FEHLER: ANTHROPIC_API_KEY nicht gesetzt.", file=sys.stderr)
        sys.exit(1)

    _install_shutdown_handler()

    print(f"[cloud_audit] Starte Klassifikation mit {CLAUDE_MODEL} …")
    client = anthropic.Anthropic(api_key=api_key, max_retries=MAX_RETRIES)
    all_results: list[dict] = list(done_results)
    total = len(anon_docs)
    aborted = False
    for i in range(0, total, BATCH_SIZE):
        if _shutdown_requested:
            break
        batch = anon_docs[i:i + BATCH_SIZE]
        print(f"  Batch {i//BATCH_SIZE + 1}/{(total + BATCH_SIZE - 1)//BATCH_SIZE} "
              f"({len(batch)} Dokumente)...")
        results, aborted = _classify_batch(
            client, batch, taxonomy, tax_outline,
            on_result=lambda row: c.checkpoint_append(CHECKPOINT_NAME, row),
        )
        all_results.extend(results)
        if aborted:
            print(
                f"[cloud_audit] Rate-Limit — Abbruch nach {len(all_results)} "
                f"Dokumenten. Teilergebnis wird ausgewertet und gespeichert; der "
                f"Checkpoint bleibt erhalten, ein neuer Lauf macht dort weiter.",
                file=sys.stderr,
            )
            break

    # A signal means the host is taking the process away, not that the audit is
    # done. Writing a report over the previous one would replace a complete
    # measurement with a partial one, so leave the reports alone and let the
    # checkpoint carry the work into the next run.
    if _shutdown_requested:
        print(
            f"[cloud_audit] Abgebrochen nach {len(all_results)} Dokumenten "
            f"(davon {len(done_results)} aus einem früheren Lauf). "
            f"Kein Report geschrieben — erneut starten, um fortzusetzen.",
            file=sys.stderr,
        )
        sys.exit(2)

    # Generate report
    report, gold = _generate_report(all_results)

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{_P}cloud_audit.md").write_text(report, encoding="utf8")
    c.write_json(OUT / f"{_P}cloud_audit_gold.json", gold)
    c.write_json(OUT / f"{_P}cloud_audit_full.json", all_results)

    # Summary
    valid = [r for r in all_results if r["claude_slug"] != "ERROR"]
    agree = sum(1 for r in valid if r["claude_slug"] == r["local_slug"])
    tax_valid = [r for r in valid if r["claude_tax_relevant"] is not None]
    local_tax_true = [r for r in tax_valid if r["local_tax_relevant"]]
    tax_confirmed = sum(1 for r in local_tax_true if r["claude_tax_relevant"])
    print(f"\n[cloud_audit] Kategorie: {agree}/{len(valid)} Übereinstimmung "
          f"({100*agree/max(1,len(valid)):.1f}%)")
    if local_tax_true:
        print(f"[cloud_audit] Steuer: {tax_confirmed}/{len(local_tax_true)} der "
              f"lokal als steuerrelevant markierten Dokumente von Claude bestätigt "
              f"({100*tax_confirmed/len(local_tax_true):.1f}%)")
    print(f"[cloud_audit] Report: {(OUT / f'{_P}cloud_audit.md').relative_to(c.REPO_ROOT)}")
    print(f"[cloud_audit] Gold-Set: {len(gold)} bestätigte Labels → {_P}cloud_audit_gold.json")
    if resumed:
        print(f"[cloud_audit] (davon {len(done_results)} Dokumente aus einem "
              f"früheren, unterbrochenen Lauf übernommen)")

    # Only a run that reached its report is finished. A rate-limit abort wrote a
    # partial report but keeps its checkpoint, so a later run can still fill in
    # the documents it never got to.
    if not aborted:
        c.checkpoint_clear(CHECKPOINT_NAME)


if __name__ == "__main__":
    main()
