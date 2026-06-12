# scripts/taxonomy — Offline-Analyse für Taxonomie & Steuer-Einordnung

Einmalige, **read-only** Skripte, um aus den bereits eingespannten Dokumenten eine
bessere Taxonomie und verlässlichere Steuer-Hints abzuleiten. Sie verändern keine
produktiven Daten; alle Ergebnisse landen unter `out/` (gitignored).

Gesamtkonzept und Etappen: siehe `docs/taxonomy-tax-quality-improvement.md`.

## Voraussetzungen

- PostgreSQL der App erreichbar (gleiche ENV wie `db/database.ts`:
  `POSTGRES_CONNECTION_STRING` **oder** `POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE`,
  Default-DB `fk_encore`).
- Für die Python-Skripte: `pip3 install -r scripts/taxonomy/requirements.txt`

## Skripte

| Skript | Etappe | Zweck |
|--------|--------|-------|
| `diagnose.mjs` | A | Read-only Zustandsbericht (Verteilungen, Gold-Set, tote Sektionen, Confusion). `npm run diagnose:taxonomy` |
| `cluster.py` | B/C | Embeddings clustern, Cluster beschreiben, Repräsentanten + anonymisierten Export erzeugen. `npm run cluster:taxonomy` |
| `mine_hints.py` | D | Absender/Keyword/Confusion-Mining → Hint-Entwürfe je Kategorie & Steuer-Sektion. `npm run mine-hints:taxonomy` |

## Typischer Ablauf

```bash
npm run diagnose:taxonomy        # 1. Zustand verstehen
pip3 install -r scripts/taxonomy/requirements.txt
npm run cluster:taxonomy         # 2. Themen-Struktur + Repräsentanten
npm run mine-hints:taxonomy      # 3. Hint-Entwürfe
```

Ergebnisse reviewen unter `scripts/taxonomy/out/`:
`diagnose.md`, `clusters.md`, `representatives.json`,
`representatives.anon.jsonl`, `hints_proposal.md`.

## Anonymisierung (optionaler Cloud-Schritt)

`cluster.py` schreibt `out/representatives.anon.jsonl`: nur gescrubbte Summaries +
Tags + Absender-*Typ* (keine Klarnamen/IBAN/Beträge, Personennamen aus
`user_subject_persons` maskiert). Nur diese Datei darf — falls gewünscht — an ein
starkes Cloud-Modell gehen, um Kategorie-Namen / eine Hierarchie vorzuschlagen.
