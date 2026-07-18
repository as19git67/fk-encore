#!/usr/bin/env python3
"""Etappe D — Datengetriebenes Mining für Taxonomie- und Steuer-Hints.

READ-ONLY. Leitet aus den real zugeordneten Dokumenten konkrete Hint-Bausteine
ab: typische Absender, charakteristische Schlüsselbegriffe (TF-IDF) und
Verwechslungs-Richtungen (Embedding-Nachbarschaft) → "NICHT: … → andere"-Regeln.
Daraus entsteht ein Hint-Entwurf je Taxonomie-Kategorie und je Steuer-Sektion,
den der Nutzer (oder optional ein starkes Modell) finalisiert.

Diagnose-Befunde, die das motivieren:
  - Abzugs-Sektionen (§35a, Krankheitskosten, Sonderausgaben, Vorsorge) werden
    faktisch nie erkannt (je ~1 Dok., Confidence 0,1).
  - `steuerbescheid` ist tot, obwohl Steuerbescheid-Dokumente existieren.
  - `tax_relevant` feuert zu selten (Wertpapiere: 267 Dok., aber nur 81
    tax_relevant gesamt) → Recall-Lücke.

Outputs (scripts/taxonomy/out/, gitignored):
  - hints_proposal.md   Hint-Entwürfe je Kategorie + je Steuer-Sektion
  - hints_mining.json   Maschinenlesbare Roh-Aggregate

Aufruf:  python3 scripts/taxonomy/mine_hints.py
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer

import _common as c

OUT = c.OUT_DIR
_P = c.today_prefix()
TOP_K_NEIGHBORS = 10

# Kompakte deutsche Stoppwortliste (TF-IDF-Rauschen reduzieren).
GERMAN_STOP = """
und oder aber als also am an auf aus bei bin bis bist da damit dann der den des
dem die das dass ein eine einer eines einem einen er es für gegen hat haben hier
ich im in ist ja kann kein keine mit nach nicht noch nun nur ob oder ohne sehr
sein sind so über um und uns unter vom von vor war waren was weil wenn wer wie
wir wird wurde zu zum zur zwar zwischen sowie per gemäss gemäß bzw inkl ggf etc
herr frau sehr geehrte geehrter datum seite nummer nr betrag euro eur summe
""".split()


def load(conn):
    sql = """
        SELECT d.id,
               COALESCE(c.slug, '(keine)') AS cat_slug,
               COALESCE(c.name, '(keine)') AS cat_name,
               d.sender,
               d.tax_relevant,
               left(coalesce(d.extracted_text, ''), 3000) AS text,
               AVG(e.embedding)::text AS vec
        FROM documents d
        JOIN document_embeddings e ON e.document_id = d.id
        LEFT JOIN document_categories c ON c.id = d.category_id
        GROUP BY d.id, c.slug, c.name, d.sender, d.tax_relevant, d.extracted_text
    """
    with conn.cursor() as cur:
        cur.execute(sql)
        cols = [col.name for col in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def tax_section_members(conn):
    """tax_section-slug → Liste document_id (source='ai')."""
    out = defaultdict(list)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT tax_section, document_id FROM document_tax_sections WHERE source='ai'"
        )
        for sec, doc in cur.fetchall():
            out[sec].append(doc)
    return out


def top_terms_per_group(docs, group_key, vectorizer, X, feature_names, n=12):
    """Mittlere TF-IDF je Gruppe → Top-Begriffe."""
    groups = defaultdict(list)
    for i, d in enumerate(docs):
        groups[group_key(d)].append(i)
    result = {}
    for g, idxs in groups.items():
        if not idxs:
            continue
        mean = np.asarray(X[idxs].mean(axis=0)).ravel()
        top = mean.argsort()[::-1][:n]
        result[g] = [feature_names[j] for j in top if mean[j] > 0]
    return result


def main() -> None:
    conn = c.connect()
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.documents')")
        if cur.fetchone()[0] is None:
            raise SystemExit(f"documents nicht gefunden (DB: {c.safe_dsn()}).")

    docs = load(conn)
    if not docs:
        raise SystemExit("Keine Dokumente mit Embeddings gefunden.")
    print(f"[hints] {len(docs)} Dokumente geladen")

    by_id = {d["id"]: d for d in docs}
    idx_of = {d["id"]: i for i, d in enumerate(docs)}

    # ── TF-IDF ──────────────────────────────────────────────────────────────
    vec = TfidfVectorizer(
        stop_words=GERMAN_STOP, lowercase=True, min_df=2, max_df=0.5,
        token_pattern=r"(?u)\b[a-zA-ZäöüÄÖÜß][a-zA-ZäöüÄÖÜß]{2,}\b",
    )
    X = vec.fit_transform(d["text"] for d in docs)
    feats = vec.get_feature_names_out()

    cat_terms = top_terms_per_group(docs, lambda d: d["cat_slug"], vec, X, feats)

    # ── Top-Absender je Kategorie ──────────────────────────────────────────
    cat_senders = defaultdict(Counter)
    cat_count = Counter()
    cat_tax = Counter()
    cat_name = {}
    for d in docs:
        cat_count[d["cat_slug"]] += 1
        cat_name[d["cat_slug"]] = d["cat_name"]
        if d["sender"]:
            cat_senders[d["cat_slug"]][d["sender"]] += 1
        if d["tax_relevant"]:
            cat_tax[d["cat_slug"]] += 1

    # ── Kategorie-Confusion über Embedding-Nachbarn ────────────────────────
    mat = np.array([json.loads(d["vec"]) for d in docs], dtype=np.float32)
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    mat /= norms
    confusion = defaultdict(Counter)  # cat → Counter(nachbar-cat)
    # Blockweise Similarity, um Speicher zu schonen.
    cats = [d["cat_slug"] for d in docs]
    B = 512
    for start in range(0, len(docs), B):
        sims = mat[start : start + B] @ mat.T  # (b, N)
        for r in range(sims.shape[0]):
            i = start + r
            sims[r, i] = -1.0
            nn = np.argpartition(sims[r], -TOP_K_NEIGHBORS)[-TOP_K_NEIGHBORS:]
            votes = Counter(cats[j] for j in nn)
            top_cat, top_n = votes.most_common(1)[0]
            if top_cat != cats[i] and top_n > TOP_K_NEIGHBORS / 2:
                confusion[cats[i]][top_cat] += 1

    # ── Steuer-Sektionen mining ─────────────────────────────────────────────
    sections = c.tax_sections()
    sec_members = tax_section_members(conn)
    sec_report = []
    for s in sections:
        ids = sec_members.get(s["slug"], [])
        senders = Counter(
            by_id[i]["sender"] for i in ids if i in by_id and by_id[i]["sender"]
        )
        member_idx = [idx_of[i] for i in ids if i in idx_of]
        terms = []
        if member_idx:
            mean = np.asarray(X[member_idx].mean(axis=0)).ravel()
            terms = [feats[j] for j in mean.argsort()[::-1][:12] if mean[j] > 0]
        sec_report.append(
            {
                "slug": s["slug"],
                "group": s["group"],
                "name": s["name"],
                "doc_count": len(ids),
                "top_senders": senders.most_common(5),
                "top_terms": terms,
            }
        )

    # ── tax_relevant Recall-Lücken ─────────────────────────────────────────
    recall_gaps = []
    for slug, n in cat_count.most_common():
        rate = cat_tax[slug] / n if n else 0
        # Kategorien mit Volumen, aber niedriger Steuer-Quote → Verdacht.
        if n >= 20 and rate < 0.3:
            recall_gaps.append((slug, cat_name.get(slug, slug), n, round(rate, 2)))

    # ── Report ──────────────────────────────────────────────────────────────
    md = c.Md()
    md("# Hint-Mining: Entwürfe für Taxonomie- und Steuer-Hints")
    md("")
    md(f"_{len(docs)} Dokumente. Entwürfe — final per Review (oder starkem Modell) "
       "schärfen. Steuer-Hints lassen sich über `tax_section_hint_overrides` sofort "
       "testen; Taxonomie-Hints gehen in `documents/taxonomy.ts`._")
    md("")

    md("## A. Taxonomie-Kategorien — Hint-Entwürfe")
    md("")
    for slug, n in cat_count.most_common():
        if slug == "(keine)":
            continue
        senders = ", ".join(s for s, _ in cat_senders[slug].most_common(5))
        terms = ", ".join(cat_terms.get(slug, [])[:10])
        nots = ", ".join(
            f"{oc} ({k})" for oc, k in confusion[slug].most_common(3)
        )
        md(f"### {cat_name.get(slug, slug)} (`{slug}`) — {n} Dok.")
        md("")
        md(f"- **Typische Absender:** {senders or '—'}")
        md(f"- **Schlüsselbegriffe:** {terms or '—'}")
        if nots:
            md(f"- **Wird verwechselt mit (→ NICHT-Regel):** {nots}")
        md(f"- **Hint-Entwurf:** Typischerweise von {senders or '…'}. "
           f"Erkennbar an: {terms or '…'}."
           + (f" NICHT verwechseln mit {nots.split(',')[0].split(' (')[0]}." if nots else ""))
        md("")

    md("## B. Steuer-Sektionen — Hint-Entwürfe (für `tax_section_hint_overrides`)")
    md("")
    group_order = ["einkuenfte", "abzuege", "bescheid", "rahmen"]
    for s in sorted(sec_report, key=lambda x: group_order.index(x["group"])):
        senders = ", ".join(f"{n} ({k})" for n, k in s["top_senders"])
        terms = ", ".join(s["top_terms"][:10])
        status = "**TOT — kein Beleg im Korpus**" if s["doc_count"] == 0 else f"{s['doc_count']} Dok."
        md(f"### {s['name']} (`{s['slug']}`, {s['group']}) — {status}")
        md("")
        if s["doc_count"]:
            md(f"- **Reale Absender:** {senders or '—'}")
            md(f"- **Schlüsselbegriffe:** {terms or '—'}")
            md(f"- **Hint-Entwurf:** Belege von {senders or '…'}. "
               f"Schlüsselbegriffe: {terms or '…'}.")
        else:
            md("- Im Korpus nicht (sicher) vorhanden — Hint stärker fassen oder "
               "Kategorie-Verknüpfung prüfen (z. B. `behoerden-steuerbescheid`).")
        md("")

    md("## C. tax_relevant — Recall-Lücken")
    md("")
    md("> Kategorien mit Volumen, aber niedriger tax_relevant-Quote — Verdacht auf "
       "übersehene Steuerrelevanz (z. B. Wertpapiere/Dividenden → anlage-kap).")
    md("")
    md.table(
        ["Kategorie", "Slug", "Dok.", "tax_relevant-Quote"],
        [[name, slug, n, f"{int(rate*100)} %"] for slug, name, n, rate in recall_gaps],
    )

    md.write(OUT / f"{_P}hints_proposal.md")

    c.write_json(
        OUT / f"{_P}hints_mining.json",
        {
            "categories": {
                slug: {
                    "name": cat_name.get(slug, slug),
                    "count": n,
                    "top_senders": cat_senders[slug].most_common(8),
                    "top_terms": cat_terms.get(slug, []),
                    "confused_with": confusion[slug].most_common(5),
                    "tax_relevant_rate": round(cat_tax[slug] / n, 3) if n else 0,
                }
                for slug, n in cat_count.most_common()
            },
            "tax_sections": sec_report,
            "tax_relevant_recall_gaps": [
                {"slug": s, "name": nm, "count": n, "rate": r}
                for s, nm, n, r in recall_gaps
            ],
        },
    )

    conn.close()
    print(f"[hints] Reports → {OUT.relative_to(c.REPO_ROOT)}/{_P}hints_proposal.md, {_P}hints_mining.json")


if __name__ == "__main__":
    main()
