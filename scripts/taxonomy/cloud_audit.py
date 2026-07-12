#!/usr/bin/env python3
"""Cloud-LLM Audit: Claude klassifiziert eine Stichprobe und wird mit Qwen verglichen.

READ-ONLY auf der DB. Schreibt einen Disagreement-Report nach
scripts/taxonomy/out/cloud_audit.md und die bestätigten Gold-Labels nach
scripts/taxonomy/out/cloud_audit_gold.json.

Prüft zwei unabhängige Achsen gegen Qwen (den lokalen Klassifikator):
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
import os
import re
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
SAMPLE_SIZE = int(os.environ.get("AUDIT_SAMPLE", "300"))
TAX_SAMPLE_SIZE = int(os.environ.get("AUDIT_TAX_SAMPLE", "100"))
BATCH_SIZE = 5
CLAUDE_MODEL = os.environ.get("AUDIT_MODEL", "claude-opus-4-8")
DRY_RUN = os.environ.get("AUDIT_DRY_RUN", "").lower() in ("1", "true", "yes")

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
    llm-service/main.py, damit Claude dieselbe Sicht wie Qwen bekommt."""
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
    d.tax_relevant AS qwen_tax_relevant,
    d.tax_year AS qwen_tax_year,
    COALESCE(
      (SELECT array_agg(dts.tax_section || '::' || dts.confidence::text)
       FROM document_tax_sections dts
       WHERE dts.document_id = d.id AND dts.source = 'ai'),
      ARRAY[]::text[]
    ) AS qwen_tax_sections_raw
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
        d["qwen_tax_sections"] = _parse_tax_sections(d.pop("qwen_tax_sections_raw", None))
        docs.append(d)
    return docs


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

    # ── B) Kategorie-fokussiert (unverändert) ────────────────────────────
    cur.execute(f"""
        SELECT {_BASE_COLUMNS}
        FROM documents d
        JOIN document_categories c ON c.id = d.category_id
        WHERE c.slug = 'sonstiges'
          AND d.id <> ALL(%s)
        ORDER BY random()
        LIMIT 100
    """, (list(picked_ids) or [-1],))
    cols = [desc[0] for desc in cur.description]
    sonstiges = _rows_to_docs(cols, cur.fetchall())
    picked_ids.update(d["id"] for d in sonstiges)

    cur.execute(f"""
        SELECT {_BASE_COLUMNS}
        FROM documents d
        JOIN document_categories c ON c.id = d.category_id
        WHERE d.classification_confidence < 0.85
          AND c.slug <> 'sonstiges'
          AND d.id <> ALL(%s)
        ORDER BY d.classification_confidence ASC
        LIMIT 50
    """, (list(picked_ids) or [-1],))
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
        "qwen_slug": doc["cat_slug"],
        "qwen_name": doc["cat_name"],
        "qwen_confidence": doc.get("confidence"),
        "qwen_tax_relevant": bool(doc.get("qwen_tax_relevant")),
        "qwen_tax_year": doc.get("qwen_tax_year"),
        "qwen_tax_sections": doc.get("qwen_tax_sections") or [],
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

def _load_tax_guidance() -> str:
    """Lies CLASSIFY_TAX_PROMPT wortgleich aus documents/classify-prompts.ts.

    So bekommt Claude im Audit exakt dieselbe STEUER-ERKENNUNG-Anleitung wie der
    lokale Klassifikator — ohne Drift, wenn der Prompt dort weiterentwickelt
    wird. Der Vergleich misst damit Modellqualität, nicht Prompt-Unterschiede.
    """
    text = (c.REPO_ROOT / "documents" / "classify-prompts.ts").read_text("utf8")
    m = re.search(r"CLASSIFY_TAX_PROMPT\s*=\s*`(.*?)`", text, re.DOTALL)
    if not m:
        raise RuntimeError(
            "CLASSIFY_TAX_PROMPT nicht in documents/classify-prompts.ts gefunden"
        )
    return m.group(1).strip()


_TAX_GUIDANCE = _load_tax_guidance()


def _build_system(tax_outline: str) -> str:
    return f"{_SYSTEM_BASE}\n{_TAX_GUIDANCE}\n\nSteuer-Sektionen (slug: Name — Hinweis):\n{tax_outline}"


def _build_user_msg(doc: dict, taxonomy: str) -> str:
    return (
        f"Taxonomie:\n{taxonomy}\n\n"
        f"Dokument (ID {doc['id']}):\n"
        f"- Titel: {doc['title']}\n"
        f"- Absender-Typ: {doc['sender_type']}\n"
        f"- Tags: {doc['tags']}\n"
        f"- Text:\n{doc['text']}\n"
    )


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


def _classify_batch(
    client: anthropic.Anthropic,
    docs: list[dict],
    taxonomy: str,
    tax_outline: str,
) -> list[dict]:
    """Classify a batch of documents via Claude. Returns one result per doc."""
    system = _build_system(tax_outline)
    results = []
    for doc in docs:
        user_msg = _build_user_msg(doc, taxonomy)
        base = {
            "doc_id": doc["id"],
            "qwen_slug": doc["qwen_slug"],
            "qwen_name": doc["qwen_name"],
            "qwen_confidence": doc["qwen_confidence"],
            "qwen_tax_relevant": doc["qwen_tax_relevant"],
            "qwen_tax_year": doc["qwen_tax_year"],
            "qwen_tax_sections": doc["qwen_tax_sections"],
            "title": doc["title"],
            "text": doc["text"][:200],
            "sender_type": doc["sender_type"],
        }
        try:
            resp = client.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=16_000,
                system=system,
                messages=[{"role": "user", "content": user_msg}],
            )
            text_block = next(
                (b for b in resp.content if getattr(b, "type", None) == "text"),
                None,
            )
            if text_block is None:
                raise ValueError("no text block in response")
            text = text_block.text.strip()
            # Strip markdown fences
            text = re.sub(r"^```(?:json)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text)
            # raw_decode stops after the first complete JSON object
            idx = text.index("{")
            parsed, _ = json.JSONDecoder().raw_decode(text, idx)
            results.append({
                **base,
                "claude_slug": parsed.get("slug", "?"),
                "claude_confidence": parsed.get("confidence", 0),
                "reasoning": parsed.get("reasoning", ""),
                "claude_tax_relevant": bool(parsed.get("tax_relevant", False)),
                "claude_tax_year": parsed.get("tax_year"),
                "claude_tax_sections": _clean_claude_tax_sections(parsed.get("tax_sections")),
                "tax_reasoning": parsed.get("tax_reasoning", ""),
            })
        except (json.JSONDecodeError, anthropic.APIError, KeyError, ValueError) as e:
            print(f"  [!] Dok {doc['id']}: {e}", file=sys.stderr)
            results.append({
                **base,
                "claude_slug": "ERROR",
                "claude_confidence": 0,
                "reasoning": str(e),
                "claude_tax_relevant": None,
                "claude_tax_year": None,
                "claude_tax_sections": [],
                "tax_reasoning": "",
            })
    return results


# ── Report ────────────────────────────────────────────────────────────────────

def _generate_report(results: list[dict]) -> tuple[str, list[dict]]:
    """Generate markdown report + gold-set JSON."""
    md = c.Md()
    md("# Cloud-Audit: Claude vs. Qwen — Kategorie & Steuer")
    md()
    md(f"_Erzeugt: {time.strftime('%Y-%m-%dT%H:%M:%S')} — "
       f"Modell: {CLAUDE_MODEL}, Stichprobe: {len(results)}_")
    md()

    total = len(results)
    errors = [r for r in results if r["claude_slug"] == "ERROR"]
    valid = [r for r in results if r["claude_slug"] != "ERROR"]
    agree = [r for r in valid if r["claude_slug"] == r["qwen_slug"]]
    disagree = [r for r in valid if r["claude_slug"] != r["qwen_slug"]]

    md("## 1. Übersicht")
    md()
    md.table(["Kennzahl", "Wert"], [
        ["Dokumente gesamt", total],
        ["API-Fehler", len(errors)],
        ["Kategorie-Übereinstimmung", f"{len(agree)} ({100*len(agree)/max(1,len(valid)):.1f}%)"],
        ["Kategorie-Disagreement", f"{len(disagree)} ({100*len(disagree)/max(1,len(valid)):.1f}%)"],
    ])

    # Disagreement by category
    md("## 2. Kategorie-Disagreements nach Qwen-Kategorie")
    md()
    by_qwen: dict[str, list[dict]] = {}
    for r in disagree:
        by_qwen.setdefault(r["qwen_slug"], []).append(r)
    rows = sorted(by_qwen.items(), key=lambda x: -len(x[1]))
    md.table(["Qwen-Kategorie", "Fälle", "Claude-Vorschläge (Top 3)"], [
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
        ["Dok-ID", "Titel", "Absender-Typ", "Qwen", "Claude", "Begründung"],
        [
            [
                r["doc_id"],
                (r["title"] or "")[:50],
                r["sender_type"],
                r["qwen_slug"],
                r["claude_slug"],
                (r["reasoning"] or "")[:80],
            ]
            for r in sorted(disagree, key=lambda x: x["qwen_slug"])
        ],
    )

    # Agreement stats by category
    md("## 4. Kategorie-Übereinstimmungsrate je Kategorie")
    md()
    all_by_cat: dict[str, dict] = {}
    for r in valid:
        cat = r["qwen_slug"]
        if cat not in all_by_cat:
            all_by_cat[cat] = {"total": 0, "agree": 0}
        all_by_cat[cat]["total"] += 1
        if r["claude_slug"] == r["qwen_slug"]:
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

    qwen_true = [r for r in tax_valid if r["qwen_tax_relevant"]]
    qwen_false = [r for r in tax_valid if not r["qwen_tax_relevant"]]
    tp = sum(1 for r in qwen_true if r["claude_tax_relevant"])  # Qwen true, Claude true
    fp = sum(1 for r in qwen_true if not r["claude_tax_relevant"])  # Qwen true, Claude false
    fn = sum(1 for r in qwen_false if r["claude_tax_relevant"])  # Qwen false, Claude true
    tn = sum(1 for r in qwen_false if not r["claude_tax_relevant"])

    md.table(["", "Claude: steuerrelevant", "Claude: nicht steuerrelevant"], [
        ["Qwen: steuerrelevant", tp, f"**{fp}**  ← mögliche False Positives"],
        ["Qwen: nicht steuerrelevant", f"{fn}  ← mögliche False Negatives", tn],
    ])
    md()
    if qwen_true:
        md(f"**Von {len(qwen_true)} Qwen-als-steuerrelevant markierten Dokumenten "
           f"bestätigt Claude {tp} ({100*tp/len(qwen_true):.1f}%).** "
           f"{fp} ({100*fp/len(qwen_true):.1f}%) hält Claude für NICHT steuerrelevant.")
        md()

    # Per-section breakdown: for every Qwen-assigned section, does Claude's own
    # tax_sections list for the same doc contain the same slug?
    md("### 5a. Bestätigungsrate je Qwen-Steuer-Sektion")
    md()
    per_section: dict[str, dict] = {}
    for r in tax_valid:
        claude_slugs = {s["slug"] for s in r["claude_tax_sections"]}
        for qs in r["qwen_tax_sections"]:
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
        ["Sektion", "Dok. (Qwen)", "Bestätigt", "Rate", "Von Claude verworfen", "Claude anderer Meinung"],
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
    tax_disagree = [r for r in tax_valid if r["qwen_tax_relevant"] != r["claude_tax_relevant"]]
    md.table(
        ["Dok-ID", "Titel", "Absender-Typ", "Qwen-Sektionen", "Claude", "Begründung"],
        [
            [
                r["doc_id"],
                (r["title"] or "")[:45],
                r["sender_type"],
                ", ".join(s["slug"] for s in r["qwen_tax_sections"]) or "—",
                "steuerrelevant: " + ", ".join(s["slug"] for s in r["claude_tax_sections"])
                if r["claude_tax_relevant"] else "NICHT steuerrelevant",
                (r["tax_reasoning"] or "")[:80],
            ]
            for r in sorted(
                tax_disagree,
                key=lambda x: (not x["qwen_tax_relevant"], x["qwen_slug"]),
            )
        ],
    )

    # Gold set: documents where Claude and Qwen agree on category. Carries tax
    # fields too whenever Claude and Qwen also agree on tax_relevant, so the
    # same run can grow both the category- and the steuer-Gold-Set.
    gold = []
    for r in agree:
        entry = {"doc_id": r["doc_id"], "slug": r["claude_slug"], "confidence": r["claude_confidence"]}
        if r["claude_tax_relevant"] is not None and r["qwen_tax_relevant"] == r["claude_tax_relevant"]:
            entry["tax_relevant"] = r["claude_tax_relevant"]
            entry["tax_sections"] = r["claude_tax_sections"]
        gold.append(entry)

    md()
    md("---")
    md()
    md(f"_Gold-Set: {len(gold)} Dokumente, bei denen Claude und Qwen bei der Kategorie "
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
    out_path = OUT / "cloud_audit_dry_run.jsonl"
    system = _build_system(tax_outline)
    with open(out_path, "w", encoding="utf8") as f:
        for doc in anon_docs:
            f.write(json.dumps({
                "doc_id": doc["id"],
                "system": system,
                "user_message": _build_user_msg(doc, taxonomy),
                "qwen_slug": doc["qwen_slug"],
                "qwen_name": doc["qwen_name"],
                "qwen_tax_relevant": doc["qwen_tax_relevant"],
                "qwen_tax_sections": doc["qwen_tax_sections"],
            }, ensure_ascii=False) + "\n")
    print(f"\n[cloud_audit] DRY RUN — {len(anon_docs)} Prompts geschrieben:")
    print(f"  {out_path.relative_to(c.REPO_ROOT)}")
    print(f"  Bitte prüfen, ob Anonymisierung ausreichend ist.")
    print(f"  Danach ohne AUDIT_DRY_RUN erneut starten.")


def main() -> None:
    print(f"[cloud_audit] Modell: {CLAUDE_MODEL}, Kategorie-Stichprobe: {SAMPLE_SIZE}, "
          f"Steuer-Stichprobe: {TAX_SAMPLE_SIZE}")
    if DRY_RUN:
        print(f"[cloud_audit] *** DRY RUN — nichts wird an die API gesendet ***")
    print(f"[cloud_audit] DB: {c.safe_dsn()}")

    conn = c.connect()
    names = c.subject_person_names(conn)
    taxonomy = _load_taxonomy_outline()
    tax_outline = _load_tax_sections_outline()
    docs = _sample_documents(conn)
    conn.close()

    if not docs:
        print("[cloud_audit] Keine Dokumente gefunden.", file=sys.stderr)
        sys.exit(1)

    # Anonymize
    anon_docs = [_anonymize_doc(d, names) for d in docs]

    if DRY_RUN:
        _write_dry_run(anon_docs, taxonomy, tax_outline)
        return

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("[cloud_audit] FEHLER: ANTHROPIC_API_KEY nicht gesetzt.", file=sys.stderr)
        sys.exit(1)

    # Classify via Claude
    client = anthropic.Anthropic(api_key=api_key)
    all_results: list[dict] = []
    total = len(anon_docs)
    for i in range(0, total, BATCH_SIZE):
        batch = anon_docs[i:i + BATCH_SIZE]
        print(f"  Batch {i//BATCH_SIZE + 1}/{(total + BATCH_SIZE - 1)//BATCH_SIZE} "
              f"({len(batch)} Dokumente)...")
        results = _classify_batch(client, batch, taxonomy, tax_outline)
        all_results.extend(results)

    # Generate report
    report, gold = _generate_report(all_results)

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "cloud_audit.md").write_text(report, encoding="utf8")
    c.write_json(OUT / "cloud_audit_gold.json", gold)
    c.write_json(OUT / "cloud_audit_full.json", all_results)

    # Summary
    valid = [r for r in all_results if r["claude_slug"] != "ERROR"]
    agree = sum(1 for r in valid if r["claude_slug"] == r["qwen_slug"])
    tax_valid = [r for r in valid if r["claude_tax_relevant"] is not None]
    qwen_tax_true = [r for r in tax_valid if r["qwen_tax_relevant"]]
    tax_confirmed = sum(1 for r in qwen_tax_true if r["claude_tax_relevant"])
    print(f"\n[cloud_audit] Kategorie: {agree}/{len(valid)} Übereinstimmung "
          f"({100*agree/max(1,len(valid)):.1f}%)")
    if qwen_tax_true:
        print(f"[cloud_audit] Steuer: {tax_confirmed}/{len(qwen_tax_true)} der "
              f"Qwen-als-steuerrelevant markierten Dokumente von Claude bestätigt "
              f"({100*tax_confirmed/len(qwen_tax_true):.1f}%)")
    print(f"[cloud_audit] Report: {(OUT / 'cloud_audit.md').relative_to(c.REPO_ROOT)}")
    print(f"[cloud_audit] Gold-Set: {len(gold)} bestätigte Labels → cloud_audit_gold.json")


if __name__ == "__main__":
    main()
