#!/usr/bin/env python3
"""Cloud-LLM Audit: Claude klassifiziert eine Stichprobe und wird mit Qwen verglichen.

READ-ONLY auf der DB. Schreibt einen Disagreement-Report nach
scripts/taxonomy/out/cloud_audit.md und die bestätigten Gold-Labels nach
scripts/taxonomy/out/cloud_audit_gold.json.

Voraussetzungen:
  pip3 install -r scripts/taxonomy/requirements.txt anthropic
  export ANTHROPIC_API_KEY=sk-ant-...

Aufruf:
  python3 scripts/taxonomy/cloud_audit.py
  AUDIT_SAMPLE=100 python3 scripts/taxonomy/cloud_audit.py   # kleinere Stichprobe
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
BATCH_SIZE = 5
CLAUDE_MODEL = os.environ.get("AUDIT_MODEL", "claude-opus-4-8")
DRY_RUN = os.environ.get("AUDIT_DRY_RUN", "").lower() in ("1", "true", "yes")

# ── Taxonomie aus dem TS-Quelltext lesen ──────────────────────────────────────

def _load_taxonomy_outline() -> str:
    """Parse taxonomy.ts into the same indented outline the local LLM sees."""
    text = (c.REPO_ROOT / "documents" / "taxonomy.ts").read_text("utf8")

    nodes: list[dict] = []
    # Extract slug, name, hint, and nesting via brace depth.
    slug_re = re.compile(r'slug:\s*"([^"]+)"')
    name_re = re.compile(r'name:\s*"([^"]+)"')
    hint_re = re.compile(r'hint:\s*"((?:[^"\\]|\\.)*)"')

    # Simple state machine: track brace depth to determine parent/child.
    # Each { increments, each } decrements. Children are those inside a
    # `children: [...]` block of a parent.
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


# ── Stichprobe ziehen ─────────────────────────────────────────────────────────

def _sample_documents(conn) -> list[dict]:
    """Stratified sample: sonstiges + low-confidence + random per category."""
    cur = conn.cursor()

    # 1. All sonstiges (up to 100)
    cur.execute("""
        SELECT d.id, d.title, d.sender, d.extracted_text,
               c.slug AS cat_slug, c.name AS cat_name,
               d.classification_confidence AS confidence,
               d.tags_text AS tags
        FROM documents d
        JOIN document_categories c ON c.id = d.category_id
        WHERE c.slug = 'sonstiges'
        ORDER BY random()
        LIMIT 100
    """)
    cols = [desc[0] for desc in cur.description]
    sonstiges = [dict(zip(cols, row)) for row in cur.fetchall()]

    # 2. Low confidence (< 0.85), excluding sonstiges already picked
    picked_ids = {d["id"] for d in sonstiges}
    cur.execute("""
        SELECT d.id, d.title, d.sender, d.extracted_text,
               c.slug AS cat_slug, c.name AS cat_name,
               d.classification_confidence AS confidence,
               d.tags_text AS tags
        FROM documents d
        JOIN document_categories c ON c.id = d.category_id
        WHERE d.classification_confidence < 0.85
          AND c.slug <> 'sonstiges'
        ORDER BY d.classification_confidence ASC
        LIMIT 50
    """)
    low_conf = [dict(zip(cols, row)) for row in cur.fetchall()
                if row[0] not in picked_ids]
    picked_ids.update(d["id"] for d in low_conf)

    # 3. Fill remaining with random stratified sample
    remaining = SAMPLE_SIZE - len(sonstiges) - len(low_conf)
    if remaining > 0:
        cur.execute("""
            SELECT d.id, d.title, d.sender, d.extracted_text,
                   c.slug AS cat_slug, c.name AS cat_name,
                   d.classification_confidence AS confidence,
                   d.tags_text AS tags
            FROM documents d
            JOIN document_categories c ON c.id = d.category_id
            WHERE c.slug <> 'sonstiges'
              AND d.classification_confidence >= 0.85
            ORDER BY random()
            LIMIT %s
        """, (remaining * 2,))  # over-sample to filter picked
        random_docs = [dict(zip(cols, row)) for row in cur.fetchall()
                       if row[0] not in picked_ids][:remaining]
    else:
        random_docs = []

    cur.close()
    all_docs = sonstiges + low_conf + random_docs
    print(f"[cloud_audit] Stichprobe: {len(sonstiges)} sonstiges + "
          f"{len(low_conf)} low-conf + {len(random_docs)} random = {len(all_docs)}")
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
    }


# ── Claude-Klassifikation ────────────────────────────────────────────────────

_SYSTEM = """Du bist ein Experte für die Klassifikation privater Haushalts-Dokumente.
Dir wird ein Dokument gezeigt (Titel, OCR-extrahierter Text, Absender-Typ, Tags)
und eine Taxonomie mit Slugs. Ordne das Dokument dem am besten passenden Slug zu.

Antworte ausschließlich mit gültigem JSON (ohne Markdown-Fences):
{"slug": "der-beste-slug", "confidence": 0.0-1.0, "reasoning": "kurze Begründung"}

Wenn kein Slug passt, verwende "sonstiges"."""


def _classify_batch(
    client: anthropic.Anthropic,
    docs: list[dict],
    taxonomy: str,
) -> list[dict]:
    """Classify a batch of documents via Claude. Returns one result per doc."""
    results = []
    for doc in docs:
        user_msg = (
            f"Taxonomie:\n{taxonomy}\n\n"
            f"Dokument (ID {doc['id']}):\n"
            f"- Titel: {doc['title']}\n"
            f"- Absender-Typ: {doc['sender_type']}\n"
            f"- Tags: {doc['tags']}\n"
            f"- Text:\n{doc['text']}\n"
        )
        try:
            resp = client.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=16_000,
                system=_SYSTEM,
                messages=[{"role": "user", "content": user_msg}],
            )
            text_block = next(
                (b for b in resp.content if getattr(b, "type", None) == "text"),
                None,
            )
            if text_block is None:
                raise ValueError("no text block in response")
            text = text_block.text.strip()
            # Strip markdown fences and extract JSON object
            text = re.sub(r"^```(?:json)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text)
            # Find first { ... } if there's surrounding text
            m = re.search(r"\{.*\}", text, re.DOTALL)
            if m:
                text = m.group(0)
            parsed = json.loads(text)
            results.append({
                "doc_id": doc["id"],
                "claude_slug": parsed.get("slug", "?"),
                "claude_confidence": parsed.get("confidence", 0),
                "reasoning": parsed.get("reasoning", ""),
                "qwen_slug": doc["qwen_slug"],
                "qwen_name": doc["qwen_name"],
                "qwen_confidence": doc["qwen_confidence"],
                "title": doc["title"],
                "text": doc["text"][:200],
                "sender_type": doc["sender_type"],
            })
        except (json.JSONDecodeError, anthropic.APIError, KeyError) as e:
            print(f"  [!] Dok {doc['id']}: {e}", file=sys.stderr)
            results.append({
                "doc_id": doc["id"],
                "claude_slug": "ERROR",
                "claude_confidence": 0,
                "reasoning": str(e),
                "qwen_slug": doc["qwen_slug"],
                "qwen_name": doc["qwen_name"],
                "qwen_confidence": doc["qwen_confidence"],
                "title": doc["title"],
                "text": doc["text"][:200],
                "sender_type": doc["sender_type"],
            })
    return results


# ── Report ────────────────────────────────────────────────────────────────────

def _generate_report(results: list[dict]) -> tuple[str, list[dict]]:
    """Generate markdown report + gold-set JSON."""
    md = c.Md()
    md("# Cloud-Audit: Claude vs. Qwen Klassifikation")
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
        ["Übereinstimmung", f"{len(agree)} ({100*len(agree)/max(1,len(valid)):.1f}%)"],
        ["Disagreement", f"{len(disagree)} ({100*len(disagree)/max(1,len(valid)):.1f}%)"],
    ])

    # Disagreement by category
    md("## 2. Disagreements nach Qwen-Kategorie")
    md()
    by_qwen: dict[str, list[dict]] = {}
    for r in disagree:
        by_qwen.setdefault(r["qwen_slug"], []).append(r)
    rows = sorted(by_qwen.items(), key=lambda x: -len(x[1]))
    md.table(["Qwen-Kategorie", "Fälle", "Claude-Vorschläge (Top 3)"], [
        [
            slug,
            len(items),
            ", ".join(f"{s} ({c}×)" for s, c in _top_n(
                [r["claude_slug"] for r in items], 3
            )),
        ]
        for slug, items in rows
    ])

    # Detailed disagreement list
    md("## 3. Alle Disagreements (Details)")
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
    md("## 4. Übereinstimmungsrate je Kategorie")
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
                [
                    cat,
                    d["total"],
                    d["agree"],
                    f"{100*d['agree']/d['total']:.0f}%",
                ]
                for cat, d in all_by_cat.items()
            ],
            key=lambda x: -x[1],
        ),
    )

    # Gold set: documents where Claude and Qwen agree
    gold = [
        {"doc_id": r["doc_id"], "slug": r["claude_slug"],
         "confidence": r["claude_confidence"]}
        for r in agree
    ]

    md()
    md("---")
    md()
    md(f"_Gold-Set: {len(gold)} Dokumente, bei denen Claude und Qwen übereinstimmen "
       f"→ `cloud_audit_gold.json`_")

    return "\n".join(md.lines), gold


def _top_n(items: list[str], n: int) -> list[tuple[str, int]]:
    counts: dict[str, int] = {}
    for x in items:
        counts[x] = counts.get(x, 0) + 1
    return sorted(counts.items(), key=lambda x: -x[1])[:n]


# ── Main ──────────────────────────────────────────────────────────────────────

def _write_dry_run(anon_docs: list[dict], taxonomy: str) -> None:
    """Write the exact prompts that would be sent to Claude, for review."""
    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / "cloud_audit_dry_run.jsonl"
    with open(out_path, "w", encoding="utf8") as f:
        for doc in anon_docs:
            user_msg = (
                f"Taxonomie:\n{taxonomy}\n\n"
                f"Dokument (ID {doc['id']}):\n"
                f"- Titel: {doc['title']}\n"
                f"- Absender-Typ: {doc['sender_type']}\n"
                f"- Tags: {doc['tags']}\n"
                f"- Text:\n{doc['text']}\n"
            )
            f.write(json.dumps({
                "doc_id": doc["id"],
                "system": _SYSTEM,
                "user_message": user_msg,
                "qwen_slug": doc["qwen_slug"],
                "qwen_name": doc["qwen_name"],
            }, ensure_ascii=False) + "\n")
    print(f"\n[cloud_audit] DRY RUN — {len(anon_docs)} Prompts geschrieben:")
    print(f"  {out_path.relative_to(c.REPO_ROOT)}")
    print(f"  Bitte prüfen, ob Anonymisierung ausreichend ist.")
    print(f"  Danach ohne AUDIT_DRY_RUN erneut starten.")


def main() -> None:
    print(f"[cloud_audit] Modell: {CLAUDE_MODEL}, Stichprobe: {SAMPLE_SIZE}")
    if DRY_RUN:
        print(f"[cloud_audit] *** DRY RUN — nichts wird an die API gesendet ***")
    print(f"[cloud_audit] DB: {c.safe_dsn()}")

    conn = c.connect()
    names = c.subject_person_names(conn)
    taxonomy = _load_taxonomy_outline()
    docs = _sample_documents(conn)
    conn.close()

    if not docs:
        print("[cloud_audit] Keine Dokumente gefunden.", file=sys.stderr)
        sys.exit(1)

    # Anonymize
    anon_docs = [_anonymize_doc(d, names) for d in docs]

    if DRY_RUN:
        _write_dry_run(anon_docs, taxonomy)
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
        results = _classify_batch(client, batch, taxonomy)
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
    print(f"\n[cloud_audit] Ergebnis: {agree}/{len(valid)} Übereinstimmung "
          f"({100*agree/max(1,len(valid)):.1f}%)")
    print(f"[cloud_audit] Report: {(OUT / 'cloud_audit.md').relative_to(c.REPO_ROOT)}")
    print(f"[cloud_audit] Gold-Set: {len(gold)} bestätigte Labels → cloud_audit_gold.json")


if __name__ == "__main__":
    main()
