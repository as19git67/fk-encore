#!/usr/bin/env python3
"""Cloud-Lehrer: Claude labelt eine strategische Auswahl und schreibt die Labels
als `source='cloud'` in die DB — um den Anteil vertrauenswürdig klassifizierter
Dokumente zu erhöhen, OHNE manuelle Klassifikation.

Abgrenzung (wichtig): Dies ersetzt NICHT die Produktions-Klassifikation. Das
lokale Qwen bleibt der Klassifikator für jedes Dokument. Claude läuft nur
gezielt und offline, um dort mehr korrekte Beispiele zu erzeugen, wo das
Gold-Set heute dünn ist. Siehe docs/design/cloud-teacher-gold-set.md.

Unterschied zum Audit (cloud_audit.py):
  - SCHREIBT in die DB (category_source='cloud', document_tax_sections.source
    ='cloud'); der Audit ist read-only.
  - Mildere Scrub-Stufe: der institutionelle Absender bleibt im Klartext
    (c.scrub_for_teacher statt c.sender_type), das gibt Claude ein stärkeres
    Kategorie-Signal (§3 des Designs).
  - Auswahl nach §5.1 (dünne Zweige + Streit-Achsen + neue Dokumente) statt der
    Audit-Stichprobe.

Nie überschrieben werden vom Lehrer: von Menschen bestätigte Werte
(category_source='user' bzw. attributes_reviewed=true für die Kategorie,
tax_reviewed=true für die Steuer). 'ai'/'cloud'-Werte werden ersetzt. Damit ist
ein Rücknehmen trivial (DELETE ... WHERE source='cloud' bzw. category_source
zurück auf 'ai' + Reclassify).

Voraussetzungen:
  pip3 install -r scripts/taxonomy/requirements.txt anthropic
  export ANTHROPIC_API_KEY=sk-ant-...

Aufruf:
  python3 scripts/taxonomy/cloud_teacher.py                    # ~400 Dokumente
  TEACHER_BATCH=200 python3 scripts/taxonomy/cloud_teacher.py  # kleinerer Lauf
  TEACHER_DRY_RUN=1 python3 scripts/taxonomy/cloud_teacher.py   # nur Prompts prüfen
  TEACHER_FOCUS_CATEGORIES=finanzen-steuern,sonstiges python3 ...
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
    print("[cloud_teacher] FEHLER: 'anthropic' nicht installiert.\n"
          "  pip3 install anthropic", file=sys.stderr)
    sys.exit(1)

import psycopg2

import _common as c
# Wiederverwendung der bewährten Prompt-/Parse-Helfer des Audits (eine Quelle
# der Wahrheit für System-Prompt, Steuer-Anleitung, Slug-Validierung und die
# Rate-Limit-Erkennung). Der Import löst am Modulanfang von cloud_audit nur das
# Einlesen von Textdateien aus — kein API-Call, kein DB-Zugriff.
from cloud_audit import (
    _build_system,
    _clean_claude_tax_sections,
    _is_rate_or_overload,
    _load_tax_sections_outline,
    _load_taxonomy_outline,
    _TEXT_CAP,
)

OUT = c.OUT_DIR
BATCH = int(os.environ.get("TEACHER_BATCH", "400"))
CLAUDE_MODEL = os.environ.get("TEACHER_MODEL", os.environ.get("AUDIT_MODEL", "claude-opus-4-8"))
# Dry-Run: nur die (gescrubbten) Prompts nach out/ schreiben, nichts senden,
# nichts schreiben. Sowohl TEACHER_DRY_RUN als auch AUDIT_DRY_RUN akzeptiert.
DRY_RUN = (os.environ.get("TEACHER_DRY_RUN", os.environ.get("AUDIT_DRY_RUN", ""))
           .lower() in ("1", "true", "yes"))
MAX_RETRIES = int(os.environ.get("TEACHER_MAX_RETRIES", os.environ.get("AUDIT_MAX_RETRIES", "8")))
REQUEST_DELAY = float(os.environ.get("TEACHER_REQUEST_DELAY", os.environ.get("AUDIT_REQUEST_DELAY", "0")))

# Bekannte Streit-Achsen (§5.1 Punkt 2): dort ist Qwen systematisch schwach.
# Als Env-Var überschreibbar, weil sich der aktuell strittige Satz verschiebt.
_DEFAULT_FOCUS = [
    "altersvorsorge-lebensversicherung",
    "altersvorsorge-rentenversicherung",
    "finanzen-steuern",
    "sonstiges",
]
FOCUS_CATEGORIES = [
    s.strip() for s in os.environ.get(
        "TEACHER_FOCUS_CATEGORIES", ",".join(_DEFAULT_FOCUS)
    ).split(",") if s.strip()
]


# ── DB-Verbindung (SCHREIBEND — anders als der read-only _common.connect) ─────

def _connect_writable():
    """Read-write Verbindung für die Label-Persistenz. Kein autocommit: pro
    Dokument wird explizit committet, damit ein Rate-Limit-Abbruch die bereits
    geschriebenen Labels behält (analog zum Teilergebnis des Audits)."""
    conn = psycopg2.connect(c.connection_string())
    conn.set_session(readonly=False, autocommit=False)
    return conn


# ── Auswahl der zu lehrenden Dokumente (§5.1) ─────────────────────────────────

# Nur Kategorie- und Steuerfelder, die für Anonymisierung + Persistenz nötig
# sind. tax_reviewed steuert den Steuer-Guard, category_id/slug den Vorher/
# Nachher-Vergleich im Report.
_SELECT_COLUMNS = """
    d.id, d.title, d.sender, d.extracted_text, d.tags_text AS tags,
    d.category_id AS qwen_category_id, c.slug AS qwen_slug, c.name AS qwen_name,
    d.classification_confidence AS confidence,
    d.tax_relevant AS qwen_tax_relevant, d.tax_year AS qwen_tax_year,
    d.tax_reviewed AS qwen_tax_reviewed
"""

# Gemeinsamer Guard: nur Dokumente, deren Kategorie noch NICHT vertrauenswürdig
# ist (weder cloud gelehrt noch vom Menschen bestätigt). So doppelt der Lehrer
# keine Arbeit und fasst nie eine manuelle Zuordnung an.
_UNTRUSTED = "d.category_source = 'ai' AND d.attributes_reviewed = false"


def _rows_to_docs(cur) -> list[dict]:
    cols = [desc[0] for desc in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def _select_documents(conn) -> list[dict]:
    """Drei Buckets nach §5.1, dedupliziert über `picked`:
      A) Dünn besetzte Kategorien — die mit den wenigsten vertrauenswürdigen
         (cloud/user) Beispielen zuerst (~50 %).
      B) Bekannte Streit-Achsen (FOCUS_CATEGORIES) (~30 %).
      C) Neue Dokumente (höchste IDs) (Rest).
    """
    cur = conn.cursor()
    picked: set[int] = set()

    thin_n = int(BATCH * 0.5)
    focus_n = int(BATCH * 0.3)

    # ── A) Dünn besetzte Kategorien ──────────────────────────────────────
    cur.execute(f"""
        WITH trusted AS (
          SELECT category_id, count(*) AS n
          FROM documents
          WHERE category_source IN ('cloud', 'user') OR attributes_reviewed = true
          GROUP BY category_id
        )
        SELECT {_SELECT_COLUMNS}
        FROM documents d
        JOIN document_categories c ON c.id = d.category_id
        LEFT JOIN trusted t ON t.category_id = d.category_id
        WHERE {_UNTRUSTED}
        ORDER BY COALESCE(t.n, 0) ASC, random()
        LIMIT %s
    """, (thin_n,))
    thin = _rows_to_docs(cur)
    picked.update(d["id"] for d in thin)

    # ── B) Streit-Achsen ─────────────────────────────────────────────────
    focus: list[dict] = []
    if FOCUS_CATEGORIES and focus_n > 0:
        cur.execute(f"""
            SELECT {_SELECT_COLUMNS}
            FROM documents d
            JOIN document_categories c ON c.id = d.category_id
            WHERE {_UNTRUSTED}
              AND c.slug = ANY(%s)
              AND d.id <> ALL(%s)
            ORDER BY random()
            LIMIT %s
        """, (FOCUS_CATEGORIES, list(picked) or [-1], focus_n))
        focus = _rows_to_docs(cur)
        picked.update(d["id"] for d in focus)

    # ── C) Neue Dokumente ────────────────────────────────────────────────
    remaining = BATCH - len(thin) - len(focus)
    new: list[dict] = []
    if remaining > 0:
        cur.execute(f"""
            SELECT {_SELECT_COLUMNS}
            FROM documents d
            JOIN document_categories c ON c.id = d.category_id
            WHERE {_UNTRUSTED}
              AND d.id <> ALL(%s)
            ORDER BY d.id DESC
            LIMIT %s
        """, (list(picked) or [-1], remaining))
        new = _rows_to_docs(cur)
        picked.update(d["id"] for d in new)

    cur.close()
    docs = thin + focus + new
    print(f"[cloud_teacher] Auswahl: {len(thin)} dünne Zweige + {len(focus)} "
          f"Streit-Achsen ({', '.join(FOCUS_CATEGORIES) or '—'}) + {len(new)} neue "
          f"= {len(docs)} Dokumente")
    return docs


# ── Anonymisierung (mildere Lehrer-Stufe: echter Absender bleibt) ─────────────

def _anonymize_doc(doc: dict, names: list[str]) -> dict:
    raw_text = (doc.get("extracted_text") or "")[:_TEXT_CAP]
    return {
        "id": doc["id"],
        "title": c.scrub_for_teacher(doc.get("title"), names) or "",
        "text": c.scrub_for_teacher(raw_text, names) or "",
        # Anders als der Audit: institutioneller Absender bleibt im Klartext
        # (nur PII gescrubbt), nicht auf einen Typ reduziert.
        "sender": c.scrub_for_teacher(doc.get("sender"), names) or "(unbekannt)",
        "tags": c.scrub_for_teacher(doc.get("tags") or "", names) or "",
        # Für Report/Persistenz durchgereicht (nicht an Claude gesendet):
        "qwen_category_id": doc["qwen_category_id"],
        "qwen_slug": doc["qwen_slug"],
        "qwen_name": doc["qwen_name"],
        "qwen_tax_relevant": bool(doc.get("qwen_tax_relevant")),
        "qwen_tax_year": doc.get("qwen_tax_year"),
        "qwen_tax_reviewed": bool(doc.get("qwen_tax_reviewed")),
    }


def _build_user_msg(doc: dict, taxonomy: str) -> str:
    """Wie der Audit-User-Prompt, aber mit echtem Absender-Klartext statt Typ."""
    return (
        f"Taxonomie:\n{taxonomy}\n\n"
        f"Dokument (ID {doc['id']}):\n"
        f"- Titel: {doc['title']}\n"
        f"- Absender: {doc['sender']}\n"
        f"- Tags: {doc['tags']}\n"
        f"- Text:\n{doc['text']}\n"
    )


# ── Claude-Klassifikation ─────────────────────────────────────────────────────

def _classify(client, doc: dict, system: str, taxonomy: str) -> tuple[dict | None, bool]:
    """Returns (label | None, aborted). None = harter Fehler (Dokument wird
    übersprungen). aborted=True = anhaltendes Rate-Limit → Lauf beenden,
    Teilergebnis behalten."""
    user_msg = _build_user_msg(doc, taxonomy)
    try:
        resp = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=16_000,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
        )
        text_block = next(
            (b for b in resp.content if getattr(b, "type", None) == "text"), None
        )
        if text_block is None:
            raise ValueError("no text block in response")
        text = text_block.text.strip()
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
        idx = text.index("{")
        parsed, _ = json.JSONDecoder().raw_decode(text, idx)
        return {
            "slug": str(parsed.get("slug", "")).strip().lower(),
            "confidence": float(parsed.get("confidence", 0) or 0),
            "reasoning": parsed.get("reasoning", ""),
            "tax_relevant": bool(parsed.get("tax_relevant", False)),
            "tax_year": parsed.get("tax_year"),
            "tax_sections": _clean_claude_tax_sections(parsed.get("tax_sections")),
            "tax_reasoning": parsed.get("tax_reasoning", ""),
        }, False
    except (json.JSONDecodeError, anthropic.APIError, KeyError, ValueError) as e:
        if _is_rate_or_overload(e):
            print(f"  [!] Rate-Limit/Overload bei Dok {doc['id']} — Abbruch, "
                  f"Teilergebnis bleibt: {e}", file=sys.stderr)
            return None, True
        print(f"  [!] Dok {doc['id']}: {e}", file=sys.stderr)
        return None, False


# ── Persistenz ────────────────────────────────────────────────────────────────

def _category_id_for_slug(conn, slug: str) -> int | None:
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM document_categories WHERE slug = %s", (slug,))
        row = cur.fetchone()
        return row[0] if row else None


def _persist(conn, doc: dict, label: dict) -> dict:
    """Schreibt Kategorie- und Steuer-Labels als source='cloud' in EINER
    Transaktion. Fasst menschlich bestätigte Werte NIE an. Gibt einen
    Report-Eintrag zurück (was tatsächlich geändert wurde)."""
    doc_id = doc["id"]
    entry: dict = {
        "doc_id": doc_id,
        "qwen_slug": doc["qwen_slug"],
        "cloud_slug": label["slug"],
        "cloud_confidence": round(label["confidence"], 3),
        "category_changed": False,
        "category_written": False,
        "tax_written": False,
        "reasoning": (label.get("reasoning") or "")[:160],
        "tax_reasoning": (label.get("tax_reasoning") or "")[:160],
    }

    cat_id = _category_id_for_slug(conn, label["slug"])
    if cat_id is None:
        print(f"  [!] Dok {doc_id}: unbekannter Kategorie-Slug '{label['slug']}' "
              f"— Kategorie nicht geschrieben", file=sys.stderr)
    else:
        with conn.cursor() as cur:
            # Guard doppelt: category_source<>'user' UND attributes_reviewed=false,
            # damit auch eine erst nach der Migration manuell gesetzte Kategorie
            # (die die App aktuell noch via attributes_reviewed markiert, nicht
            # via category_source) geschützt bleibt.
            cur.execute("""
                UPDATE documents
                SET category_id = %s, category_source = 'cloud'
                WHERE id = %s AND category_source <> 'user' AND attributes_reviewed = false
            """, (cat_id, doc_id))
            if cur.rowcount > 0:
                entry["category_written"] = True
                entry["category_changed"] = (cat_id != doc["qwen_category_id"])

    # Steuer nur anfassen, wenn kein Mensch die Steuerfelder gepinnt hat.
    if not doc["qwen_tax_reviewed"]:
        with conn.cursor() as cur:
            # 'ai'/'cloud'-Rows ersetzen, 'user'-Rows behalten.
            cur.execute("""
                DELETE FROM document_tax_sections
                WHERE document_id = %s AND source IN ('ai', 'cloud')
            """, (doc_id,))
            for s in label["tax_sections"]:
                cur.execute("""
                    INSERT INTO document_tax_sections
                        (document_id, tax_section, confidence, source)
                    VALUES (%s, %s, %s, 'cloud')
                    ON CONFLICT (document_id, tax_section) DO NOTHING
                """, (doc_id, s["slug"], s["confidence"]))
            year = label["tax_year"] if isinstance(label["tax_year"], int) else None
            cur.execute("""
                UPDATE documents
                SET tax_relevant = %s,
                    tax_year = COALESCE(%s, tax_year)
                WHERE id = %s AND tax_reviewed = false
            """, (label["tax_relevant"], year, doc_id))
            entry["tax_written"] = True
            entry["cloud_tax_relevant"] = label["tax_relevant"]
            entry["cloud_tax_sections"] = [s["slug"] for s in label["tax_sections"]]

    conn.commit()
    return entry


# ── Dry-Run / Report ──────────────────────────────────────────────────────────

def _write_dry_run(anon_docs: list[dict], taxonomy: str, tax_outline: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / "cloud_teacher_dry_run.jsonl"
    system = _build_system(tax_outline)
    with open(out_path, "w", encoding="utf8") as f:
        for doc in anon_docs:
            f.write(json.dumps({
                "doc_id": doc["id"],
                "system": system,
                "user_message": _build_user_msg(doc, taxonomy),
                "qwen_slug": doc["qwen_slug"],
            }, ensure_ascii=False) + "\n")
    print(f"\n[cloud_teacher] DRY RUN — {len(anon_docs)} Prompts geschrieben:")
    print(f"  {out_path.relative_to(c.REPO_ROOT)}")
    print(f"  Anonymisierung prüfen (institutioneller Absender bleibt Klartext!),")
    print(f"  danach ohne TEACHER_DRY_RUN erneut starten.")


def _write_report(entries: list[dict]) -> None:
    md = c.Md()
    md("# Cloud-Lehrer: geschriebene Labels")
    md()
    md(f"_Erzeugt: {time.strftime('%Y-%m-%dT%H:%M:%S')} — Modell: {CLAUDE_MODEL}, "
       f"Dokumente: {len(entries)}_")
    md()
    cat_written = [e for e in entries if e["category_written"]]
    cat_changed = [e for e in entries if e["category_changed"]]
    tax_written = [e for e in entries if e["tax_written"]]
    md.table(["Kennzahl", "Wert"], [
        ["Dokumente gelabelt", len(entries)],
        ["Kategorie geschrieben (source=cloud)", len(cat_written)],
        ["davon Kategorie geändert ggü. Qwen", len(cat_changed)],
        ["Steuer geschrieben (source=cloud)", len(tax_written)],
    ])
    md("## Kategorie-Änderungen (Qwen → Cloud)")
    md()
    md.table(
        ["Dok-ID", "Qwen", "Cloud", "Conf.", "Begründung"],
        [[e["doc_id"], e["qwen_slug"], e["cloud_slug"], e["cloud_confidence"],
          e["reasoning"]] for e in sorted(cat_changed, key=lambda x: x["qwen_slug"])],
    )
    md.write(OUT / "cloud_teacher.md")
    c.write_json(OUT / "cloud_teacher_labels.json", entries)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"[cloud_teacher] Modell: {CLAUDE_MODEL}, Batch: {BATCH}")
    if DRY_RUN:
        print(f"[cloud_teacher] *** DRY RUN — nichts wird gesendet/geschrieben ***")
    print(f"[cloud_teacher] DB: {c.safe_dsn()}")

    conn = _connect_writable()
    names = c.household_names(conn)
    taxonomy = _load_taxonomy_outline()
    tax_outline = _load_tax_sections_outline()
    docs = _select_documents(conn)

    if not docs:
        print("[cloud_teacher] Keine untrainierten Dokumente gefunden.", file=sys.stderr)
        conn.close()
        return

    anon_docs = [_anonymize_doc(d, names) for d in docs]

    if DRY_RUN:
        _write_dry_run(anon_docs, taxonomy, tax_outline)
        conn.close()
        return

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("[cloud_teacher] FEHLER: ANTHROPIC_API_KEY nicht gesetzt.", file=sys.stderr)
        conn.close()
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key, max_retries=MAX_RETRIES)
    system = _build_system(tax_outline)
    entries: list[dict] = []
    total = len(anon_docs)
    for i, doc in enumerate(anon_docs, 1):
        if i % 25 == 1 or i == total:
            print(f"  {i}/{total} …")
        label, aborted = _classify(client, doc, system, taxonomy)
        if aborted:
            print(f"[cloud_teacher] Rate-Limit — Abbruch nach {len(entries)}/{total} "
                  f"geschriebenen Dokumenten. Teilergebnis bleibt persistent.",
                  file=sys.stderr)
            break
        if label is None:
            continue
        if not label["slug"]:
            continue
        entries.append(_persist(conn, doc, label))
        if REQUEST_DELAY > 0:
            time.sleep(REQUEST_DELAY)

    conn.close()

    if entries:
        _write_report(entries)
        cat_written = sum(1 for e in entries if e["category_written"])
        cat_changed = sum(1 for e in entries if e["category_changed"])
        tax_written = sum(1 for e in entries if e["tax_written"])
        print(f"\n[cloud_teacher] Geschrieben: {cat_written} Kategorie-Labels "
              f"(davon {cat_changed} geändert), {tax_written} Steuer-Labels — "
              f"alle source='cloud'.")
        print(f"[cloud_teacher] Report: {(OUT / 'cloud_teacher.md').relative_to(c.REPO_ROOT)}")
        print(f"[cloud_teacher] Labels: {(OUT / 'cloud_teacher_labels.json').relative_to(c.REPO_ROOT)}")
        print(f"[cloud_teacher] Rücknahme: DELETE FROM document_tax_sections WHERE "
              f"source='cloud'; UPDATE documents SET category_source='ai' WHERE "
              f"category_source='cloud'; danach Reclassify.")
    else:
        print("[cloud_teacher] Keine Labels geschrieben.")


if __name__ == "__main__":
    main()
