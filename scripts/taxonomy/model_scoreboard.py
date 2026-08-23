#!/usr/bin/env python3
"""Modell-Scoreboard: misst den aktuellen lokalen Klassifikator gegen ein
Referenz-Labelset und vergleicht mehrere Läufe miteinander.

Zweck: einen Modellwechsel (Qwen3-14B → MoE, Mistral, …) entscheiden zu können,
statt ihn zu erraten. Ablauf pro Kandidat:

    1. Modell in llm_service einspielen, Stichprobe neu klassifizieren lassen.
    2. `python3 scripts/taxonomy/model_scoreboard.py --label qwen3-14b`
       → schreibt out/<datum>-scoreboard-<label>.json + .md
    3. Nächstes Modell, Schritt 1–2 wiederholen.
    4. `python3 scripts/taxonomy/model_scoreboard.py --compare \\
           out/…-scoreboard-qwen3-14b.json out/…-scoreboard-mistral.json`

READ-ONLY auf der DB — wie alle Skripte hier.

## Woher die Referenz kommt

`cloud_audit.py` schreibt zwei Dateien, und die Wahl zwischen ihnen ist keine
Formalie:

* `cloud_audit_full.json` (Default) enthält Claudes Urteil zu **jedem**
  Dokument der Stichprobe. Das ist die faire Referenz für einen Modellvergleich.
* `cloud_audit_gold.json` enthält nur die Dokumente, bei denen Claude und das
  **damalige** lokale Modell übereinstimmten. Als Referenz für einen Vergleich
  ist dieses Set zugunsten des Amtsinhabers verzerrt: Fälle, die das alte Modell
  falsch hatte, sind darin gar nicht vertreten, ein besseres Modell kann dort
  also nur verlieren. Nutzbar über --reference, aber mit diesem Vorbehalt.

Claude ist dabei nicht die Wahrheit, sondern ein starker zweiter Leser. Eine
Abweichung ist ein Prüfhinweis, keine Fehlermeldung — die Zahlen taugen zum
Vergleich zweier Modelle gegen dieselbe Referenz, nicht als absolute Güte.

## Was gemessen wird

* **Kategorie**: Trefferquote gesamt und je Referenz-Kategorie, plus die
  häufigsten Verwechslungen.
* **Steuerrelevanz**: Konfusionsmatrix, Precision und Recall. Getrennt
  ausgewiesen, weil ein Modell hier anders falsch liegen kann als bei der
  Kategorie — zu viel Steuerrelevanz verschmutzt die Steueransicht, zu wenig
  lässt Dokumente verschwinden.
* **Steuersektionen**: exakte Mengengleichheit plus Jaccard-Ähnlichkeit, damit
  "eine von drei Sektionen daneben" nicht wie ein Totalausfall zählt.
* **Abdeckung**: wie viele Referenz-Dokumente überhaupt gefunden wurden. Fehlen
  viele, wurde die Stichprobe nicht vollständig neu klassifiziert und die
  Trefferquoten beziehen sich auf einen Ausschnitt.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _common as c  # noqa: E402

OUT = c.OUT_DIR


# ── Referenz laden ────────────────────────────────────────────────────────────

def _latest(base: str) -> Path | None:
    """Neueste datumspräfixierte Variante von *base* in out/ (wie taxonomy-tools)."""
    if not OUT.is_dir():
        return None
    matches = sorted(OUT.glob(f"*-{base}"))
    plain = OUT / base
    if plain.exists():
        matches.append(plain)
    return matches[-1] if matches else None


# Labels end up in a filename, and the admin UI lets an operator type one, so
# restrict them to characters that cannot walk out of out/ or confuse the glob
# that finds snapshots again.
_LABEL_RE = re.compile(r"^[A-Za-z0-9._-]{1,40}$")


def _check_label(label: str) -> str:
    if not _LABEL_RE.match(label):
        raise SystemExit(
            f"[scoreboard] Ungültiges Label {label!r}: erlaubt sind 1–40 Zeichen "
            "aus A–Z, a–z, 0–9, Punkt, Bindestrich und Unterstrich."
        )
    return label


def _latest_snapshot(label: str, *, exclude: Path | None = None) -> Path | None:
    """Neuester Scoreboard-Snapshot zu *label*."""
    if not OUT.is_dir():
        return None
    matches = sorted(p for p in OUT.glob(f"*-scoreboard-{label}.json") if p != exclude)
    return matches[-1] if matches else None


def _load_reference(path: Path) -> tuple[list[dict], str]:
    """Referenzlabels aus einer cloud_audit-Ausgabe.

    Beide Formate werden am Feldnamen erkannt statt am Dateinamen, damit auch
    eine umbenannte oder von Hand zusammengestellte Datei funktioniert.
    """

    raw = json.loads(path.read_text(encoding="utf8"))
    if not isinstance(raw, list) or not raw:
        raise SystemExit(f"[scoreboard] {path.name}: leer oder keine Liste")

    entries: list[dict] = []
    if "claude_slug" in raw[0]:          # cloud_audit_full.json
        kind = "full"
        for r in raw:
            if r.get("claude_slug") in (None, "ERROR"):
                continue               # Claude selbst hat hier nichts geliefert
            entries.append({
                "doc_id": r["doc_id"],
                "slug": r["claude_slug"],
                "tax_relevant": r.get("claude_tax_relevant"),
                "tax_sections": [s["slug"] for s in r.get("claude_tax_sections") or []],
                "title": r.get("title") or "",
            })
    else:                                # cloud_audit_gold.json
        kind = "gold"
        for r in raw:
            entries.append({
                "doc_id": r["doc_id"],
                "slug": r["slug"],
                "tax_relevant": r.get("tax_relevant"),
                "tax_sections": [s["slug"] for s in r.get("tax_sections") or []],
                "title": "",
            })
    return entries, kind


# ── Ist-Zustand aus der DB ────────────────────────────────────────────────────

def _load_current(doc_ids: list[int]) -> dict[int, dict]:
    conn = c.connect()
    cur = conn.cursor()
    # LEFT JOIN on purpose. An INNER JOIN silently dropped documents whose
    # category_id is NULL, and they were then reported as "not found in the DB"
    # — which sent the reader looking for deleted rows when the document was
    # right there without a category. The two cases have different causes and
    # different fixes, so they are kept apart: a NULL category is reported as
    # its own bucket below.
    cur.execute("""
        SELECT d.id,
               cat.slug,
               d.tax_relevant,
               d.classification_confidence,
               COALESCE(
                 (SELECT array_agg(dts.tax_section)
                  FROM document_tax_sections dts
                  WHERE dts.document_id = d.id AND dts.source = 'ai'),
                 ARRAY[]::text[]
               )
        FROM documents d
        LEFT JOIN document_categories cat ON cat.id = d.category_id
        WHERE d.id = ANY(%s)
    """, (doc_ids,))
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return {
        r[0]: {
            "slug": r[1],
            "tax_relevant": bool(r[2]),
            "confidence": float(r[3]) if r[3] is not None else None,
            "tax_sections": sorted(r[4] or []),
        }
        for r in rows
    }


# ── Auswertung ────────────────────────────────────────────────────────────────

def _jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)


def _score(reference: list[dict], current: dict[int, dict]) -> dict[str, Any]:
    per_doc: list[dict] = []
    missing: list[int] = []
    # Row exists but carries no category. Scored as unrated like `missing`, but
    # counted separately: the row being gone points at a deleted document, a
    # NULL category at a classify run that could not resolve the slug it got.
    uncategorised: list[int] = []

    for ref in reference:
        cur = current.get(ref["doc_id"])
        if cur is None:
            missing.append(ref["doc_id"])
            continue
        if cur["slug"] is None:
            uncategorised.append(ref["doc_id"])
            continue
        ref_sections = set(ref["tax_sections"])
        cur_sections = set(cur["tax_sections"])
        per_doc.append({
            "doc_id": ref["doc_id"],
            "title": ref["title"],
            "ref_slug": ref["slug"],
            "got_slug": cur["slug"],
            "slug_hit": ref["slug"] == cur["slug"],
            "confidence": cur["confidence"],
            "ref_tax": ref["tax_relevant"],
            "got_tax": cur["tax_relevant"],
            "ref_sections": sorted(ref_sections),
            "got_sections": sorted(cur_sections),
            "sections_exact": ref_sections == cur_sections,
            "sections_jaccard": round(_jaccard(ref_sections, cur_sections), 4),
        })

    hits = sum(1 for d in per_doc if d["slug_hit"])
    n = len(per_doc)

    # Kategorie je Referenzklasse: zeigt, *wo* ein Modell schwächelt. Ein
    # Gesamtwert allein verdeckt, dass ein Kandidat z.B. nur bei "sonstiges"
    # verliert — was harmlos wäre — oder quer durch die Steuerkategorien.
    by_ref: dict[str, dict[str, Any]] = {}
    for d in per_doc:
        e = by_ref.setdefault(d["ref_slug"], {"n": 0, "hits": 0, "confused_with": {}})
        e["n"] += 1
        if d["slug_hit"]:
            e["hits"] += 1
        else:
            e["confused_with"][d["got_slug"]] = e["confused_with"].get(d["got_slug"], 0) + 1

    # Steuerrelevanz nur über Dokumente, für die die Referenz eine Aussage hat.
    tax_docs = [d for d in per_doc if d["ref_tax"] is not None]
    tp = sum(1 for d in tax_docs if d["ref_tax"] and d["got_tax"])
    fp = sum(1 for d in tax_docs if not d["ref_tax"] and d["got_tax"])
    fn = sum(1 for d in tax_docs if d["ref_tax"] and not d["got_tax"])
    tn = sum(1 for d in tax_docs if not d["ref_tax"] and not d["got_tax"])

    # Sektionen nur dort, wo beide Seiten das Dokument für steuerrelevant halten
    # — bei Uneinigkeit über die Relevanz misst ein Sektionsvergleich nichts
    # Eigenes mehr, sondern doppelt nur den Relevanz-Fehler.
    sec_docs = [d for d in tax_docs if d["ref_tax"] and d["got_tax"]]

    return {
        "n_reference": len(reference),
        "n_scored": n,
        "n_missing": len(missing),
        "missing_doc_ids": missing[:50],
        "n_uncategorised": len(uncategorised),
        "uncategorised_doc_ids": uncategorised[:50],
        "category": {
            "hits": hits,
            "accuracy": round(hits / n, 4) if n else None,
            "by_ref_slug": {
                slug: {
                    "n": e["n"],
                    "hits": e["hits"],
                    "accuracy": round(e["hits"] / e["n"], 4),
                    "confused_with": dict(sorted(e["confused_with"].items(), key=lambda x: -x[1])[:3]),
                }
                for slug, e in sorted(by_ref.items(), key=lambda x: -x[1]["n"])
            },
        },
        "tax_relevant": {
            "n": len(tax_docs),
            "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "precision": round(tp / (tp + fp), 4) if (tp + fp) else None,
            "recall": round(tp / (tp + fn), 4) if (tp + fn) else None,
            "accuracy": round((tp + tn) / len(tax_docs), 4) if tax_docs else None,
        },
        "tax_sections": {
            "n": len(sec_docs),
            "exact": sum(1 for d in sec_docs if d["sections_exact"]),
            "exact_rate": round(
                sum(1 for d in sec_docs if d["sections_exact"]) / len(sec_docs), 4
            ) if sec_docs else None,
            "mean_jaccard": round(
                sum(d["sections_jaccard"] for d in sec_docs) / len(sec_docs), 4
            ) if sec_docs else None,
        },
        "per_doc": per_doc,
    }


# ── Ausgabe ───────────────────────────────────────────────────────────────────

def _pct(x: float | None) -> str:
    return "—" if x is None else f"{100 * x:.1f} %"


def _report(label: str, ref_path: Path, ref_kind: str, s: dict[str, Any]) -> str:
    L: list[str] = []
    L.append(f"# Modell-Scoreboard: `{label}`")
    L.append("")
    L.append(f"Referenz: `{ref_path.name}` ({ref_kind}), {s['n_reference']} Labels — "
             f"{s['n_scored']} bewertet, {s['n_missing']} nicht in der DB gefunden.")
    if ref_kind == "gold":
        L.append("")
        L.append("> **Achtung:** Das Gold-Set enthält nur Dokumente, bei denen Claude und "
                 "das *damalige* lokale Modell übereinstimmten. Als Vergleichsreferenz ist "
                 "es zugunsten dieses Modells verzerrt. Für Modellvergleiche ist "
                 "`cloud_audit_full.json` die fairere Wahl.")
    if s["n_missing"]:
        n = s["n_missing"]
        L.append("")
        L.append(f"> {n} Referenz-{'Dokument' if n == 1 else 'Dokumente'} nicht in der DB "
                 f"gefunden — die Zeile existiert nicht mehr (gelöscht?). "
                 f"IDs: {', '.join(str(i) for i in s['missing_doc_ids'])}")
    if s.get("n_uncategorised"):
        n = s["n_uncategorised"]
        L.append("")
        L.append(f"> {n} Referenz-{'Dokument' if n == 1 else 'Dokumente'} ohne Kategorie in "
                 f"der DB. Die Dokumente existieren, haben aber `category_id IS NULL` — "
                 f"typischerweise, weil der Klassifikator einen Slug geliefert hat, den es "
                 f"in der Taxonomie nicht gibt. "
                 f"IDs: {', '.join(str(i) for i in s['uncategorised_doc_ids'])}")
    L.append("")

    cat = s["category"]
    L.append("## Kategorie")
    L.append("")
    L.append(f"**{cat['hits']}/{s['n_scored']} = {_pct(cat['accuracy'])}**")
    L.append("")
    L.append("| Referenz-Kategorie | n | Treffer | Quote | häufigste Verwechslung |")
    L.append("|---|---:|---:|---:|---|")
    for slug, e in cat["by_ref_slug"].items():
        confused = ", ".join(f"{k} ({v})" for k, v in e["confused_with"].items()) or "—"
        L.append(f"| `{slug}` | {e['n']} | {e['hits']} | {_pct(e['accuracy'])} | {confused} |")
    L.append("")

    t = s["tax_relevant"]
    L.append("## Steuerrelevanz")
    L.append("")
    L.append(f"Precision {_pct(t['precision'])} · Recall {_pct(t['recall'])} · "
             f"Genauigkeit {_pct(t['accuracy'])} (n = {t['n']})")
    L.append("")
    L.append("| | Referenz: relevant | Referenz: nicht relevant |")
    L.append("|---|---:|---:|")
    L.append(f"| **Modell: relevant** | {t['tp']} | {t['fp']} |")
    L.append(f"| **Modell: nicht relevant** | {t['fn']} | {t['tn']} |")
    L.append("")

    sec = s["tax_sections"]
    L.append("## Steuersektionen")
    L.append("")
    L.append(f"Exakt gleiche Menge: {sec['exact']}/{sec['n']} = {_pct(sec['exact_rate'])} · "
             f"mittlere Jaccard-Ähnlichkeit {sec['mean_jaccard'] if sec['mean_jaccard'] is not None else '—'}")
    L.append("")

    wrong = [d for d in s["per_doc"] if not d["slug_hit"]]
    if wrong:
        L.append("## Abweichungen bei der Kategorie")
        L.append("")
        L.append("| Dok | Titel | Referenz | Modell | Konfidenz |")
        L.append("|---:|---|---|---|---:|")
        for d in sorted(wrong, key=lambda x: x["ref_slug"])[:80]:
            conf = "—" if d["confidence"] is None else f"{d['confidence']:.2f}"
            L.append(f"| {d['doc_id']} | {(d['title'] or '')[:50]} | `{d['ref_slug']}` "
                     f"| `{d['got_slug']}` | {conf} |")
        if len(wrong) > 80:
            L.append("")
            L.append(f"_… und {len(wrong) - 80} weitere (vollständig im JSON)._")
        L.append("")

    return "\n".join(L)


def _compare(paths: list[Path]) -> str:
    """Zwei oder mehr Snapshots nebeneinander, plus die Dokumente, die gekippt sind."""

    snaps = []
    for p in paths:
        data = json.loads(p.read_text(encoding="utf8"))
        snaps.append((data.get("label") or p.stem, data))

    L: list[str] = ["# Modellvergleich", ""]
    refs = {json.dumps(d.get("reference"), sort_keys=True) for _, d in snaps}
    if len(refs) > 1:
        L.append("> **Achtung:** Die Snapshots wurden gegen *unterschiedliche* Referenzen "
                 "gemessen. Die Zahlen sind damit nicht direkt vergleichbar.")
        L.append("")

    L.append("| Metrik | " + " | ".join(lbl for lbl, _ in snaps) + " |")
    L.append("|---|" + "---:|" * len(snaps))

    def row(name: str, fn) -> None:
        L.append(f"| {name} | " + " | ".join(fn(d["scores"]) for _, d in snaps) + " |")

    row("bewertete Dokumente", lambda s: str(s["n_scored"]))
    row("Kategorie-Trefferquote", lambda s: _pct(s["category"]["accuracy"]))
    row("Steuer: Precision", lambda s: _pct(s["tax_relevant"]["precision"]))
    row("Steuer: Recall", lambda s: _pct(s["tax_relevant"]["recall"]))
    row("Sektionen exakt", lambda s: _pct(s["tax_sections"]["exact_rate"]))
    L.append("")

    # Der eigentliche Erkenntnisgewinn steckt nicht im Mittelwert, sondern in
    # den Dokumenten, die zwischen zwei Kandidaten die Seite gewechselt haben:
    # dort sieht man, *welche* Art von Dokument der eine besser trifft.
    if len(snaps) == 2:
        (label_a, a), (label_b, b) = snaps
        by_id_a = {d["doc_id"]: d for d in a["scores"]["per_doc"]}
        by_id_b = {d["doc_id"]: d for d in b["scores"]["per_doc"]}
        both = sorted(set(by_id_a) & set(by_id_b))
        gained = [i for i in both if not by_id_a[i]["slug_hit"] and by_id_b[i]["slug_hit"]]
        lost = [i for i in both if by_id_a[i]["slug_hit"] and not by_id_b[i]["slug_hit"]]

        L.append(f"## Kategorie-Wechsel: `{label_a}` → `{label_b}`")
        L.append("")
        L.append(f"{len(gained)} gewonnen, {len(lost)} verloren "
                 f"(gemeinsame Grundmenge: {len(both)} Dokumente)")
        L.append("")
        for title, ids in (("Neu richtig", gained), ("Neu falsch", lost)):
            if not ids:
                continue
            L.append(f"### {title}")
            L.append("")
            L.append("| Dok | Referenz | " + f"{label_a} | {label_b} |")
            L.append("|---:|---|---|---|")
            for i in ids[:60]:
                L.append(f"| {i} | `{by_id_a[i]['ref_slug']}` | "
                         f"`{by_id_a[i]['got_slug']}` | `{by_id_b[i]['got_slug']}` |")
            if len(ids) > 60:
                L.append("")
                L.append(f"_… und {len(ids) - 60} weitere._")
            L.append("")

    return "\n".join(L)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(
        description="Misst den aktuellen lokalen Klassifikator gegen ein Referenz-Labelset.",
    )
    ap.add_argument("--label", help="Name des Laufs, z.B. das Modell (qwen3-14b, mistral-small)")
    ap.add_argument("--reference", type=Path,
                    help="cloud_audit_full.json (Default) oder cloud_audit_gold.json")
    ap.add_argument("--compare", type=Path, nargs="+", metavar="SNAPSHOT",
                    help="Zwei oder mehr Scoreboard-JSONs vergleichen statt neu zu messen")
    ap.add_argument("--compare-with", metavar="LABEL",
                    help="Nach dem Messen zusätzlich gegen den neuesten Snapshot dieses "
                         "Labels vergleichen (spart das Heraussuchen der Dateinamen)")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)

    if args.compare:
        if len(args.compare) < 2:
            raise SystemExit("[scoreboard] --compare braucht mindestens zwei Snapshots")
        report = _compare(args.compare)
        path = OUT / f"{c.today_prefix()}scoreboard_compare.md"
        path.write_text(report, encoding="utf8")
        print(report)
        print(f"\n[scoreboard] Vergleich: {path.relative_to(c.REPO_ROOT)}")
        return

    if not args.label:
        raise SystemExit("[scoreboard] --label fehlt (Name des Laufs, z.B. das Modell)")
    _check_label(args.label)
    if args.compare_with:
        _check_label(args.compare_with)

    ref_path = args.reference or _latest("cloud_audit_full.json") or _latest("cloud_audit_gold.json")
    if ref_path is None or not ref_path.exists():
        raise SystemExit(
            "[scoreboard] Keine Referenz gefunden. Erst `npm run audit:taxonomy` laufen "
            "lassen (schreibt out/cloud_audit_full.json), oder --reference angeben."
        )

    reference, ref_kind = _load_reference(ref_path)
    print(f"[scoreboard] Referenz: {ref_path.name} ({ref_kind}), {len(reference)} Labels")
    print(f"[scoreboard] DB: {c.safe_dsn()}")

    current = _load_current([r["doc_id"] for r in reference])
    print(f"[scoreboard] {len(current)} Dokumente in der DB gefunden")

    scores = _score(reference, current)

    snapshot = {
        "label": args.label,
        "reference": {"file": ref_path.name, "kind": ref_kind, "n": len(reference)},
        "scores": scores,
    }
    json_path = OUT / f"{c.today_prefix()}scoreboard-{args.label}.json"
    md_path = OUT / f"{c.today_prefix()}scoreboard-{args.label}.md"
    c.write_json(json_path, snapshot)
    md_path.write_text(_report(args.label, ref_path, ref_kind, scores), encoding="utf8")

    cat = scores["category"]
    tax = scores["tax_relevant"]
    print(f"\n[scoreboard] Kategorie: {cat['hits']}/{scores['n_scored']} = {_pct(cat['accuracy'])}")
    print(f"[scoreboard] Steuer: Precision {_pct(tax['precision'])}, Recall {_pct(tax['recall'])}")
    print(f"[scoreboard] Report:   {md_path.relative_to(c.REPO_ROOT)}")
    print(f"[scoreboard] Snapshot: {json_path.relative_to(c.REPO_ROOT)}")

    if args.compare_with:
        previous = _latest_snapshot(args.compare_with, exclude=json_path)
        if previous is None:
            print(f"\n[scoreboard] Kein Snapshot zu --compare-with {args.compare_with!r} "
                  f"gefunden — Vergleich übersprungen.")
        else:
            # Der ältere Lauf zuerst, damit "Neu richtig" die Dokumente meint,
            # die *dieser* Lauf gewonnen hat.
            report = _compare([previous, json_path])
            cmp_path = OUT / f"{c.today_prefix()}scoreboard_compare.md"
            cmp_path.write_text(report, encoding="utf8")
            print(report)
            print(f"[scoreboard] Vergleich mit {previous.name}: "
                  f"{cmp_path.relative_to(c.REPO_ROOT)}")
        return

    print(f"\n[scoreboard] Nächstes Modell messen, dann:\n"
          f"  python3 scripts/taxonomy/model_scoreboard.py --label <neues-modell> "
          f"--compare-with {args.label}")


if __name__ == "__main__":
    main()
