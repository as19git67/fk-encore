#!/usr/bin/env python3
"""Nimmt einzelne Kategorie-Labels des Cloud-Lehrers zurück.

Der Lehrer schreibt jede Kategorie als category_source='cloud'. Ein Label, dem
er selbst wenig traut oder das sich als falsch herausstellt, soll nicht als
vertrauenswürdig stehen bleiben. Dieses Skript stellt für solche Dokumente die
Kategorie wieder her, die das lokale Modell vor dem Lauf vergeben hatte
(`qwen_slug` in der Labels-Datei des Laufs), und setzt category_source zurück
auf 'ai'. Ein späteres Reclassify behandelt sie dann wie jedes andere
KI-Label.

Angefasst wird nur, was noch der Lehrer geschrieben hat: category_source =
'cloud' und attributes_reviewed = false. Was ein Mensch inzwischen bestätigt
oder geändert hat, bleibt stehen. Die Steuer-Labels des Laufs bleiben ebenfalls
unverändert.

Aufruf:
  python3 scripts/taxonomy/cloud_teacher_revert.py LABELS.json --below 0.65
  python3 scripts/taxonomy/cloud_teacher_revert.py LABELS.json --ids 101,102
  python3 scripts/taxonomy/cloud_teacher_revert.py LABELS.json --below 0.65 --ids 101,102 --dry-run

LABELS.json ist die `*_cloud_teacher_labels.json` des Laufs. Die Dokument-IDs
gehören in die Kommandozeile, nicht ins Repo.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import psycopg2

import _common as c


def _select(entries: list[dict], below: float | None, ids: set[int]) -> list[dict]:
    picked = []
    for e in entries:
        if not e.get("category_written"):
            continue
        low = below is not None and float(e.get("cloud_confidence") or 0) < below
        if low or int(e["doc_id"]) in ids:
            picked.append(e)
    return picked


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("labels", type=Path, help="*_cloud_teacher_labels.json des Laufs")
    ap.add_argument("--below", type=float, default=None,
                    help="alle Labels mit Konfidenz unter diesem Wert zurücknehmen")
    ap.add_argument("--ids", default="",
                    help="zusätzlich diese Dokument-IDs (kommagetrennt) zurücknehmen")
    ap.add_argument("--dry-run", action="store_true", help="nur anzeigen, nichts schreiben")
    args = ap.parse_args()

    ids = {int(x) for x in args.ids.split(",") if x.strip()}
    if args.below is None and not ids:
        ap.error("--below oder --ids angeben")

    entries = json.loads(args.labels.read_text(encoding="utf8"))
    picked = _select(entries, args.below, ids)
    missing = ids - {int(e["doc_id"]) for e in picked}
    if missing:
        print(f"[revert] Nicht in der Labels-Datei (oder nicht geschrieben): "
              f"{', '.join(map(str, sorted(missing)))}", file=sys.stderr)
    print(f"[revert] {len(picked)} Labels ausgewählt — DB: {c.safe_dsn()}")

    conn = psycopg2.connect(c.connection_string())
    conn.set_session(readonly=args.dry_run, autocommit=False)
    reverted = skipped = 0
    with conn.cursor() as cur:
        for e in picked:
            cur.execute("SELECT id FROM document_categories WHERE slug = %s", (e["qwen_slug"],))
            row = cur.fetchone()
            if row is None:
                print(f"  Dok {e['doc_id']}: früherer Slug '{e['qwen_slug']}' existiert nicht — übersprungen")
                skipped += 1
                continue
            if args.dry_run:
                print(f"  Dok {e['doc_id']}: {e['cloud_slug']} → {e['qwen_slug']} "
                      f"(Conf. {e['cloud_confidence']})")
                reverted += 1
                continue
            cur.execute("""
                UPDATE documents
                SET category_id = %s, category_source = 'ai'
                WHERE id = %s AND category_source = 'cloud' AND attributes_reviewed = false
            """, (row[0], e["doc_id"]))
            if cur.rowcount > 0:
                reverted += 1
                print(f"  Dok {e['doc_id']}: {e['cloud_slug']} → {e['qwen_slug']}")
            else:
                skipped += 1
                print(f"  Dok {e['doc_id']}: inzwischen geprüft oder geändert — übersprungen")
    if not args.dry_run:
        conn.commit()
    conn.close()
    verb = "würden zurückgenommen" if args.dry_run else "zurückgenommen"
    print(f"[revert] {reverted} {verb}, {skipped} übersprungen.")


if __name__ == "__main__":
    main()
