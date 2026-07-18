#!/usr/bin/env python3
"""Etappe B/C — Clustering der Dokument-Embeddings + Repräsentanten-Auswahl.

READ-ONLY. Leitet aus den bereits gespeicherten Embeddings eine datengetriebene
Cluster-Struktur ab, beschreibt jeden Cluster (Größe, Kategorie-Zusammensetzung,
Top-Absender, Beispiel-Dokumente) und wählt repräsentative Dokumente aus. Die
Repräsentanten werden zusätzlich anonymisiert exportiert, damit optional ein
starkes Cloud-Modell daraus Kategorie-Namen / eine Hierarchie vorschlagen kann.

Diagnose-Befund, der das motiviert: 83,5 % des Korpus stecken in den zwei
Sammelkategorien `finanzen-rechnungen` und `sonstiges`. Clustering zeigt, welche
realen Themen darin verborgen sind → konkrete Taxonomie-Korrekturen.

Outputs (scripts/taxonomy/out/, gitignored):
  - clusters.md                Menschlicher Report (ein Abschnitt je Cluster)
  - clusters.json              Maschinenlesbar (Cluster + Mitglieder + Kennzahlen)
  - representatives.json       Ausgewählte Repräsentanten + Quelle + Metadaten
  - representatives.anon.jsonl Anonymisierte Summaries für optionalen Cloud-Schritt

Konfiguration (ENV):
  MIN_CLUSTER_SIZE   HDBSCAN-Mindestgröße (Default 15)
  MIN_SAMPLES        HDBSCAN min_samples (Default = MIN_CLUSTER_SIZE)
  TARGET             "all" (Default) oder "catchall" (nur Rechnungen+Sonstiges)
  N_REPRESENTATIVES  Ziel-Anzahl Repräsentanten gesamt (Default 300)

Aufruf:  python3 scripts/taxonomy/cluster.py
"""

from __future__ import annotations

import json
import os
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.cluster import HDBSCAN

import _common as c

OUT = c.OUT_DIR
_P = c.today_prefix()
MIN_CLUSTER_SIZE = int(os.environ.get("MIN_CLUSTER_SIZE", "15"))
MIN_SAMPLES = int(os.environ.get("MIN_SAMPLES", str(MIN_CLUSTER_SIZE)))
TARGET = os.environ.get("TARGET", "all")
N_REPRESENTATIVES = int(os.environ.get("N_REPRESENTATIVES", "300"))
CATCHALL_SLUGS = ("finanzen-rechnungen", "sonstiges")


def load_documents(conn):
    """Pro Dokument: gemittelter Embedding-Vektor + Metadaten."""
    where = ""
    if TARGET == "catchall":
        where = "WHERE c.slug IN %(slugs)s" % {"slugs": str(CATCHALL_SLUGS)}
    sql = f"""
        SELECT d.id,
               COALESCE(c.slug, '(keine)')  AS cat_slug,
               COALESCE(c.name, '(keine)')  AS cat_name,
               d.sender,
               d.title,
               d.summary,
               d.tags_text,
               d.tax_relevant,
               AVG(e.embedding)::text       AS vec
        FROM documents d
        JOIN document_embeddings e ON e.document_id = d.id
        LEFT JOIN document_categories c ON c.id = d.category_id
        {where}
        GROUP BY d.id, c.slug, c.name, d.sender, d.title, d.summary,
                 d.tags_text, d.tax_relevant
    """
    with conn.cursor() as cur:
        cur.execute(sql)
        cols = [col.name for col in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    return rows


def l2_normalize(mat: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return mat / norms


def top_counter(items, n):
    return Counter(x for x in items if x).most_common(n)


def farthest_first(vectors: np.ndarray, k: int, seed_idx: int = 0) -> list[int]:
    """Diversitäts-Sampling (Max-Min): k Indizes, die den Raum breit abdecken."""
    n = len(vectors)
    if k >= n:
        return list(range(n))
    chosen = [seed_idx]
    min_d = np.linalg.norm(vectors - vectors[seed_idx], axis=1)
    for _ in range(k - 1):
        nxt = int(np.argmax(min_d))
        chosen.append(nxt)
        d = np.linalg.norm(vectors - vectors[nxt], axis=1)
        min_d = np.minimum(min_d, d)
    return chosen


def main() -> None:
    conn = c.connect()
    # Sanity
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.document_embeddings')")
        if cur.fetchone()[0] is None:
            raise SystemExit(
                f"Tabelle document_embeddings nicht gefunden (DB: {c.safe_dsn()}). "
                "POSTGRES_CONNECTION_STRING korrekt?"
            )

    docs = load_documents(conn)
    if not docs:
        raise SystemExit("Keine Dokumente mit Embeddings gefunden.")
    print(f"[cluster] {len(docs)} Dokumente mit Embeddings geladen (TARGET={TARGET})")

    mat = np.array([json.loads(d["vec"]) for d in docs], dtype=np.float32)
    mat = l2_normalize(mat)

    labels = HDBSCAN(
        min_cluster_size=MIN_CLUSTER_SIZE,
        min_samples=MIN_SAMPLES,
        metric="euclidean",  # auf L2-normierten Vektoren ≈ Cosine
        copy=True,
    ).fit_predict(mat)

    n_clusters = len({l for l in labels if l >= 0})
    n_noise = int((labels == -1).sum())
    print(f"[cluster] {n_clusters} Cluster, {n_noise} Ausreißer (noise)")

    # Cluster-Beschreibungen + Medoide
    clusters = []
    for cid in sorted({l for l in labels if l >= 0}):
        idx = np.where(labels == cid)[0]
        sub = mat[idx]
        centroid = sub.mean(axis=0)
        d_to_centroid = np.linalg.norm(sub - centroid, axis=1)
        order = idx[np.argsort(d_to_centroid)]
        medoid = int(order[0])
        members = [docs[i] for i in idx]
        comp = top_counter((m["cat_slug"] for m in members), 5)
        senders = top_counter((m["sender"] for m in members), 5)
        tax_rate = sum(1 for m in members if m["tax_relevant"]) / len(members)
        clusters.append(
            {
                "cluster_id": int(cid),
                "size": len(idx),
                "category_composition": comp,
                "top_senders": senders,
                "tax_relevant_rate": round(tax_rate, 3),
                "medoid_doc_id": docs[medoid]["id"],
                "example_doc_ids": [docs[i]["id"] for i in order[:6]],
                "example_titles": [docs[i].get("title") for i in order[:6]],
                "_member_idx": idx.tolist(),
                "_medoid_idx": medoid,
            }
        )
    clusters.sort(key=lambda x: x["size"], reverse=True)

    # ── Report clusters.md ──────────────────────────────────────────────────
    md = c.Md()
    md("# Clustering: datengetriebene Themen-Struktur")
    md("")
    md(f"_TARGET={TARGET}, min_cluster_size={MIN_CLUSTER_SIZE}. "
       f"{len(docs)} Dokumente → {n_clusters} Cluster, {n_noise} Ausreißer._")
    md("")
    md("> Lesart: Cluster, die überwiegend aus `finanzen-rechnungen`/`sonstiges` "
       "bestehen **und** kohärente Absender haben, sind Kandidaten für eine **neue "
       "Kategorie** oder ein **Re-Routing**. Gemischte Cluster zeigen unscharfe Grenzen.")
    md("")
    for cl in clusters:
        comp = ", ".join(f"{s} ({n})" for s, n in cl["category_composition"])
        senders = ", ".join(f"{s} ({n})" for s, n in cl["top_senders"])
        catchall = sum(n for s, n in cl["category_composition"] if s in CATCHALL_SLUGS)
        flag = " 🔎 **Sammelkategorie-lastig**" if catchall > cl["size"] / 2 else ""
        md(f"### Cluster {cl['cluster_id']} — {cl['size']} Dok.{flag}")
        md("")
        md(f"- **Kategorien:** {comp}")
        md(f"- **Top-Absender:** {senders or '—'}")
        md(f"- **tax_relevant-Quote:** {int(cl['tax_relevant_rate'] * 100)} %")
        md(f"- **Medoid (typischstes Dok.):** #{cl['medoid_doc_id']}")
        titles = [t for t in cl["example_titles"] if t]
        if titles:
            md(f"- **Beispiel-Titel:** {('; '.join(titles[:5]))}")
        md("")
    if n_noise:
        md(f"### Ausreißer (noise): {n_noise} Dokumente")
        md("")
        md("Passen in kein Cluster — typische Quelle für fehlende Kategorien. "
           "In den Repräsentanten enthalten.")
        md("")
    md.write(OUT / f"{_P}clusters.md")

    # ── Maschinenlesbar ─────────────────────────────────────────────────────
    c.write_json(
        OUT / f"{_P}clusters.json",
        [{k: v for k, v in cl.items() if not k.startswith("_")} for cl in clusters],
    )

    # ── Repräsentanten-Auswahl ──────────────────────────────────────────────
    rep_idx: dict[int, str] = {}  # doc-index → Quelle
    # 1) Medoide + nächste je Cluster
    per_cluster = max(1, N_REPRESENTATIVES // max(1, len(clusters) * 2))
    for cl in clusters:
        for i in cl["_member_idx"][:1]:
            rep_idx.setdefault(cl["_medoid_idx"], "medoid")
        # nächste am Medoid
        sub_idx = np.array(cl["_member_idx"])
        d = np.linalg.norm(mat[sub_idx] - mat[cl["_medoid_idx"]], axis=1)
        for i in sub_idx[np.argsort(d)][:per_cluster]:
            rep_idx.setdefault(int(i), "cluster-nah")
    # 2) Diversitäts-Sampling über alle
    for i in farthest_first(mat, min(N_REPRESENTATIVES // 3, len(docs))):
        rep_idx.setdefault(int(i), "diversität")
    # 3) Problemfälle: Sammelkategorie + Ausreißer
    for i, d in enumerate(docs):
        if len(rep_idx) >= N_REPRESENTATIVES * 1.5:
            break
        if labels[i] == -1 or d["cat_slug"] in CATCHALL_SLUGS:
            rep_idx.setdefault(i, "problemfall")

    names = c.subject_person_names(conn)
    representatives = []
    anon = []
    for i, source in rep_idx.items():
        d = docs[i]
        representatives.append(
            {
                "doc_id": d["id"],
                "source": source,
                "cluster": int(labels[i]),
                "category_slug": d["cat_slug"],
                "sender": d["sender"],
                "title": d.get("title"),
                "summary": d.get("summary"),
            }
        )
        anon.append(
            {
                "doc_id": d["id"],
                "cluster": int(labels[i]),
                "current_category": d["cat_slug"],
                "sender_type": c.sender_type(d["sender"]),
                "summary": c.scrub(c.scrub_names(d.get("summary"), names)),
                "tags": c.scrub(c.scrub_names(d.get("tags_text"), names)),
            }
        )
    c.write_json(OUT / f"{_P}representatives.json", representatives)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{_P}representatives.anon.jsonl").write_text(
        "\n".join(json.dumps(a, ensure_ascii=False) for a in anon), encoding="utf8"
    )

    conn.close()
    print(f"[cluster] Repräsentanten: {len(representatives)} "
          f"(anonymisiert → {_P}representatives.anon.jsonl)")
    print(f"[cluster] Reports → {OUT.relative_to(c.REPO_ROOT)}/{_P}clusters.md, {_P}clusters.json")


if __name__ == "__main__":
    main()
