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
| `cloud_audit.py` | F | Cloud-LLM-Audit: Claude klassifiziert eine Stichprobe, Disagreement-Report + Gold-Set. `npm run audit:taxonomy` |

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

## Cloud-Audit (Etappe F)

`cloud_audit.py` lässt Claude eine Stichprobe klassifizieren und vergleicht das
Ergebnis mit der lokalen Qwen-Klassifikation auf zwei unabhängigen Achsen:

- **Kategorie** (Default-Stichprobe 300: sonstiges + low-confidence + random).
- **Steuerrelevanz / -sektionen** (Default-Stichprobe 100, gezielt aus den
  aktuell auffälligen bzw. vorher toten Sektionen — `AUDIT_TAX_FOCUS_SECTIONS`).
  Claude bekommt dieselbe STEUER-ERKENNUNG-Anleitung wie der lokale
  Klassifikator (wortgleich aus `documents/classify-prompts.ts`), damit der
  Vergleich Modellqualität misst statt Prompt-Unterschiede.

PII wird vor dem API-Call gescruppt (gleiche Infrastruktur wie `_common.py`).

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run audit:taxonomy                     # Standard-Stichprobe (300 Kategorie + 100 Steuer)
AUDIT_SAMPLE=100 npm run audit:taxonomy    # kleinere Kategorie-Stichprobe
AUDIT_TAX_SAMPLE=50 npm run audit:taxonomy # kleinere Steuer-Stichprobe
AUDIT_TAX_FOCUS_SECTIONS=anlage-g,anlage-kind npm run audit:taxonomy  # andere Fokus-Sektionen
AUDIT_MODEL=claude-sonnet-4-20250514 npm run audit:taxonomy  # anderes Modell
AUDIT_DRY_RUN=1 npm run audit:taxonomy     # Prompts nur schreiben, nichts an die API senden
```

**Rate-Limits:** Der SDK-Client retryt 429/5xx/Verbindungsfehler automatisch mit
exponentiellem Backoff (respektiert `Retry-After`); `AUDIT_MAX_RETRIES` (Default
8) hebt die Obergrenze. Reißt das Limit trotzdem anhaltend, bricht der Lauf
sauber ab und wertet das **Teilergebnis** aus, statt den Rest der Stichprobe an
dieselbe Wand zu fahren. `AUDIT_REQUEST_DELAY=1` fügt eine feste Pause (Sekunden)
zwischen den Requests ein, um proaktiv unter dem Minutenlimit zu bleiben.

```bash
AUDIT_REQUEST_DELAY=1.5 AUDIT_TAX_SAMPLE=60 AUDIT_SAMPLE=0 npm run audit:taxonomy  # schonend, nur Steuer-Achse
```

Ergebnisse: `out/cloud_audit.md` (Disagreement-Report — §1–4 Kategorie, §5
Steuer inkl. Confusion-Matrix "Qwen steuerrelevant vs. Claude bestätigt" und
Bestätigungsrate je Sektion), `out/cloud_audit_gold.json` (bestätigte
Gold-Labels, inkl. Steuerfeldern wo auch dort Übereinstimmung besteht),
`out/cloud_audit_full.json` (alle Ergebnisse).

## Modell-Scoreboard (`model_scoreboard.py`)

Misst den **aktuellen** lokalen Klassifikator gegen ein Referenz-Labelset aus
dem Cloud-Audit und vergleicht mehrere Läufe. Damit wird ein Modellwechsel
(Qwen3-14B → MoE, Mistral, …) messbar statt Geschmackssache.

```bash
# 1. Baseline: Stichprobe mit dem aktuellen Modell klassifiziert lassen, dann
npm run scoreboard:taxonomy -- --label qwen3-14b

# 2. Anderes Modell in llm_service, Stichprobe neu klassifizieren, dann
npm run scoreboard:taxonomy -- --label mistral-small

# 3. Vergleichen
npm run scoreboard:taxonomy -- --compare \
  out/2026-08-15-scoreboard-qwen3-14b.json \
  out/2026-08-15-scoreboard-mistral-small.json
```

Referenz ist standardmäßig `out/cloud_audit_full.json` — Claudes Urteil zu
**jedem** Dokument der Stichprobe. `out/cloud_audit_gold.json` ist über
`--reference` nutzbar, aber als Vergleichsmaßstab zugunsten des damaligen
Modells verzerrt: es enthält nur Dokumente, bei denen jenes Modell bereits mit
Claude übereinstimmte, ein besserer Kandidat kann dort also nur verlieren.

Gemessen werden Kategorie-Trefferquote (gesamt und je Referenzkategorie, mit
den häufigsten Verwechslungen), Steuerrelevanz (Konfusionsmatrix, Precision,
Recall) und Steuersektionen (exakte Mengengleichheit + Jaccard). Der Vergleich
zweier Snapshots listet zusätzlich die Dokumente, die **gekippt** sind — dort
steht, welche Art von Dokument der eine Kandidat besser trifft, was ein
Mittelwert nie zeigt.

Ergebnisse: `out/<datum>-scoreboard-<label>.{md,json}` und
`out/<datum>-scoreboard_compare.md`.

## Anonymisierung

`cluster.py` schreibt `out/representatives.anon.jsonl`: nur gescrubbte Summaries +
Tags + Absender-*Typ* (keine Klarnamen/IBAN/Beträge, Personennamen aus
`user_subject_persons` maskiert). Nur diese Datei darf — falls gewünscht — an ein
starkes Cloud-Modell gehen, um Kategorie-Namen / eine Hierarchie vorzuschlagen.

`cloud_audit.py` nutzt dieselbe PII-Scrubbing-Infrastruktur: Titel, Summary und
Tags werden vor dem Claude-API-Call anonymisiert; Absender werden nur als Typ
(Behörde/Firma/Person/Unbekannt) übergeben.
