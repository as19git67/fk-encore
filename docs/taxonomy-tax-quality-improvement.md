# Plan: Taxonomie & Steuer-Einordnung datengetrieben verbessern

Status: **Entwurf zum Review — noch keine Implementierung.**
Ziel: Aus den bereits eingespannten Dokumenten der letzten Jahre **einmalig** eine
vollständige, belastbare Taxonomie und eine vollständige Hints-Aufstellung für die
Steuer-Einordnung ableiten. Bevorzugt lokal; Cloud nur für wenige hundert
**anonymisierte** Repräsentanten, wo ein starkes Modell echten Mehrwert bringt.

---

## 0. Ausgangslage (Ist-Zustand im Code)

- **Taxonomie**: fest in `documents/taxonomy.ts` (12 Top-Kategorien + ~40 Unter-
  kategorien), geseedet via `db/seed.ts` → Tabelle `document_categories`.
  Optionale `hint`-Felder pro Kategorie. **Kein** Runtime-Override für Taxonomie-Hints.
- **Steuer-Sektionen**: 30 feste Slugs in `documents/tax-sections.ts`, je mit `hint`.
  Hints zur Laufzeit tunebar über Tabelle `tax_section_hint_overrides`
  (`documents/tax-hint-overrides.ts`).
- **Klassifikation**: lokales Llama-GGUF (`llm-service/main.py`), **Zero-Shot**,
  JSON-Grammar, `temperature=0.2`, `max_tokens=768`. Prompt enthält Taxonomie-Outline,
  Steuer-Sektionen (gruppiert) und Bezugspersonen.
- **Embeddings**: `intfloat/multilingual-e5-base` (768-dim), pro Dokument-Chunk in
  `document_embeddings` gespeichert.
- **Bereits persistierte Daten je Dokument** (das Rohmaterial dieses Plans):
  - `documents.extracted_text` (OCR-Volltext)
  - `documents.summary` (1–2 neutrale deutsche Sätze), `tags`
  - `documents.classification_confidence`, `documents.sender`, `documents.doc_date`
  - `documents.tax_relevant`, `tax_year`, `tax_year_confidence`, `tax_reviewed`
  - `document_tax_sections` (document_id, tax_section, confidence, source ∈ {ai,user})
  - `document_embeddings` (document_id, chunk_idx, embedding)

**Konsequenz:** Wir müssen die tausenden PDFs **nicht neu durch OCR/LLM jagen**. Alles
für Clustering, Repräsentanten-Auswahl und Hint-Mining liegt schon in der DB.

### 0.1 Wie stark hängt der Plan an manuell korrigierten Dokumenten?

**Antwort: wenig — und bewusst asymmetrisch.** Die Taxonomie-Ableitung (Etappe B/C)
ist **unsupervised** und braucht überhaupt keine manuellen Labels; sie arbeitet nur
auf den Embeddings. Manuelle Korrekturen nutzt der Plan ausschließlich dort, wo das
Schema sie sauber als „vom Menschen bestätigt" markiert — und das ist ungleich verteilt:

| Feld | Manuelles Signal im Schema | Als „Wahrheit" nutzbar? |
|------|----------------------------|-------------------------|
| Steuer-Relevanz / `tax_year` | `documents.tax_reviewed` (→ true bei Nutzer-Edit) | **Ja, sauber** |
| Steuer-Sektionen | `document_tax_sections.source ∈ {ai, user}` | **Ja, sauber** |
| Kategorie | **kein** `source`/`reviewed`-Flag auf `category_id` — Nutzerkorrektur überschreibt den AI-Wert ununterscheidbar | **Nein** |
| Tags | `document_tag_links` hat **keine** `source`-Spalte (anders als Finance-Tags) | **Nein** |

**Folgen für den Plan:**
- Die manuelle Abhängigkeit beschränkt sich auf das **Steuer-Gold-Set** (Etappe A/F:
  `tax_reviewed=true`, `source='user'`) und die **Few-Shot-Positiv-Beispiele** (Etappe E).
  Ist dieses Set klein, ist nur das Eval-Gate schwächer — die Taxonomie-Ableitung bleibt
  davon unberührt.
- Für **Kategorie und Tags** lässt sich aus der DB **kein** Gold-Set automatisch bauen
  (kein Marker). Deshalb dient die Handprüfung der ~150–400 Repräsentanten (Etappe C/F)
  bewusst als Ersatz für das fehlende Signal.
- **Etappe A zählt als Allererstes** die vorhandenen Mengen (`tax_reviewed=true`,
  `source='user'`-Sektionen, korrigierte Anteile), damit wir wissen, ob das Gold-Set
  fürs Eval-Gate reicht oder per Handprüfung aufgestockt werden muss.

**Optionaler Zukunfts-Fix (nicht Voraussetzung für diesen Einmal-Lauf):** eine
`category_source`-Spalte (`ai`/`user`) auf `documents` und eine `source`-Spalte auf
`document_tag_links` — analog zu den Steuer-Sektionen. Dann werden *künftige* Kategorie-/
Tag-Korrekturen mineable, und das Reclassify überschreibt sie nicht mehr. Macht die
nächste Iteration deutlich stärker.

---

## 1. Leitprinzipien

1. **Erst messen, dann ändern.** Keine Taxonomie-Operation ohne Diagnose-Zahlen.
2. **Lokal zuerst.** Clustering, Repräsentanten-Auswahl, Mining laufen vollständig
   lokal (Python, vorhandene `llm-service`-Umgebung + sklearn/hdbscan).
3. **Cloud nur für Repräsentanten, nur anonymisiert.** Höchstens ein paar hundert
   `summary`-Texte (nicht Roh-OCR), nach PII-Scrubbing.
4. **Versionierbar.** Ergebnisse (Taxonomie, Hints) landen als Code-Diffs in
   `taxonomy.ts` / `tax-sections.ts` bzw. als reproduzierbare Seed-Dateien — keine
   undokumentierten DB-Handänderungen.
5. **Mess-Schleife.** Vorher/Nachher-Genauigkeit auf einem kleinen Gold-Set, sonst
   ist „besser" nicht überprüfbar.
6. **Einmal-Charakter.** Alles unter `scripts/taxonomy/` als Offline-Tools, die die
   Produktion nicht berühren (read-only auf der DB, Output als Dateien zum Review).

---

## 2. Werkzeug- und Ablage-Struktur (geplant)

```
scripts/taxonomy/
  00_diagnose.py        # Read-only Report über Ist-Zuordnungen
  01_doc_vectors.py     # Chunk-Embeddings → 1 Vektor/Dokument (mean-pool)
  02_cluster.py         # HDBSCAN/hierarchisch → Cluster + Ausreißer
  03_representatives.py # Medoide + Diversitäts-Sampling + Problemfälle
  04_anonymize.py       # PII-Scrubbing der Repräsentanten-Summaries
  05_propose_taxonomy.* # (lokal ODER Cloud) Cluster benennen + Baum vorschlagen
  06_mine_hints.py      # Absender/Keyword/Confusion-Mining je Kategorie+Sektion
  07_write_hints.*      # (lokal ODER Cloud) finale Hints formulieren
  08_eval.py            # Gold-Set: Vorher/Nachher-Genauigkeit
  out/                  # Reports, Vorschläge, anonymisierte Exporte (gitignored)
```

DB-Zugriff aus Python via `psycopg` + pgvector gegen die Encore-Postgres-Instanz
(read-only Rolle). Clustering mit `numpy`/`scikit-learn`/`hdbscan` (neue Dev-Deps,
nur für die Skripte — nicht im Laufzeit-Image des `llm-service`).

---

## 3. Etappe A — Diagnose (read-only, lokal, ~1 Tag)

**Skript:** `00_diagnose.py`. Ausschließlich `SELECT`. Output: `out/diagnose.md`.

Kennzahlen:
- Verteilung über `document_categories` inkl. **`sonstiges`-Quote** und Anteil mit
  `classification_confidence < 0.5`. → Taxonomie-Lücken.
- Histogramm `classification_confidence` gesamt und je Top-Kategorie.
- Steuer-Sektionen: Anzahl Dokumente je `tax_section` (source='ai'); **nie** und
  **fast immer** vergebene Sektionen; mittlere Confidence je Sektion. → tote /
  überladene Sektionen.
- Häufigste `sender` je Kategorie und je Steuer-Sektion. → Überlappungen sichtbar.
- **Confusion-Heuristik** (nutzt Embeddings, ohne Labels): für jedes Dokument die
  k=10 nächsten Nachbarn; Anteil, deren Mehrheit in einer *anderen* Kategorie liegt
  als das Dokument selbst → Liste wahrscheinlicher Fehlklassifikationen, gruppiert
  nach „von Kategorie X fälschlich wie Y".
- `tax_reviewed=true`-Dokumente werden als **Mini-Gold-Set** markiert (vom Nutzer
  bestätigte Wahrheit) und für Etappe F beiseitegelegt.

**Entscheidungsausgang:** Der Report sagt, ob das Problem primär Struktur (Etappe C),
Hints (Etappe D) oder Modell (Etappe E) ist.

---

## 4. Etappe B — Dokument-Vektoren & Clustering (lokal)

**`01_doc_vectors.py`**
- Lädt alle `document_embeddings`, **Mean-Pooling** über Chunks → ein L2-normierter
  768-dim Vektor je Dokument. Persistenz als `out/doc_vectors.npy` + ID-Index.

**`02_cluster.py`**
- **HDBSCAN** (findet Clusteranzahl selbst, markiert Ausreißer als `-1`) als Default;
  optional Agglomerative/Ward für eine explizite **Hierarchie**, falls wir die
  Baumstruktur direkt ableiten wollen.
- Output `out/clusters.json`: Cluster-ID → Dokument-IDs, Cluster-Größe,
  Intra-Cluster-Kohäsion, Ausreißer-Liste.
- Sanity-Check: Cluster gegen bestehende Kategorien kreuztabellieren — zeigt, welche
  Cluster sauber einer Kategorie entsprechen, welche zwei Kategorien mischen
  (Merge-Kandidat) und welche quer zu `sonstiges` liegen (neue Kategorie).

---

## 5. Etappe C — Repräsentanten & Taxonomie-Vorschlag

### 5.1 Repräsentanten herauspicken (`03_representatives.py`, lokal)

Drei Quellen kombiniert, Ziel ~150–400 Dokumente gesamt:
- **Medoide**: je Cluster das zentralste Dokument + k nächste (typische Vertreter).
- **Diversitäts-Sampling**: Max-Min/Facility-Location über alle Vektoren (deckt die
  Bandbreite ab, fängt Seltenes).
- **Problemfälle**: niedrige Confidence, `sonstiges`, HDBSCAN-Ausreißer (zeigen
  Ränder/Lücken).

Output `out/representatives.json` (Dokument-IDs + Quelle + `summary` + `tags` +
`sender`).

### 5.2 Anonymisierung (`04_anonymize.py`, lokal — Pflicht vor jedem Cloud-Schritt)

Auf `summary`/`tags`/`sender` der Repräsentanten:
- Namen aus der **Bezugspersonen-Liste** (Tabelle vorhanden) maskieren.
- Regex/Presidio: IBAN, Steuer-/Sozial-IDs, Adressen, Telefon, E-Mail, Geldbeträge,
  Geburtsdaten → Platzhalter (`[BETRAG]`, `[NAME]`, `[ADRESSE]` …).
- **Nur `summary` + `tags` + Absender-*Typ*** (z. B. „Bank", „Finanzamt", „Arzt")
  verlassen die Maschine — **kein** Roh-OCR, keine Klarnamen.
- Output `out/representatives.anon.jsonl` + ein Diff-Report, der zeigt, was maskiert
  wurde (zum Sichtprüfen vor dem Upload).

### 5.3 Taxonomie vorschlagen (`05_propose_taxonomy`)

- **Lokal-Variante**: das vorhandene Llama benennt/gruppiert die Cluster aus den
  anonymisierten Summaries. Günstig, datensicher, ggf. gröber.
- **Cloud-Variante (empfohlen, anonymisiert)**: die ~150–400 anonymisierten
  Repräsentanten-Summaries gehen **einmalig** an ein starkes Modell (Claude) mit der
  Aufgabe: vollständige, hierarchische Taxonomie vorschlagen, bestehende
  `taxonomy.ts` als Ausgangspunkt, Lücken/Merges explizit begründen.
- Output `out/taxonomy.proposal.md`: vorgeschlagener Baum + Mapping „alter Slug →
  neuer Slug" + Begründung je Änderung. **Reiner Vorschlag** — Übernahme nach
  manuellem Review als Diff in `taxonomy.ts` (+ `seed.ts` bleibt idempotent;
  Slug-Umbenennungen brauchen eine kleine Migration für `document_categories`).

---

## 6. Etappe D — Vollständige Hints-Aufstellung

### 6.1 Mining (`06_mine_hints.py`, lokal)

Je Taxonomie-Kategorie **und** je Steuer-Sektion aus den real zugeordneten
Dokumenten aggregieren:
- Top-Absender (echte Institutsnamen → konkrete Hint-Beispiele).
- Charakteristische Schlüsselbegriffe (TF-IDF gegen den Restkorpus).
- **Confusion-Paare** aus Etappe A → Kandidaten für „NICHT: … → andere-sektion"-Regeln
  (genau das Muster, das die heutigen Hints schon nutzen, z. B. `anlage-n` vs
  `anlage-kap`).
- Output `out/hints.mining.json`.

### 6.2 Formulieren (`07_write_hints`)

- Aus dem Mining je Slug einen finalen `hint` formulieren (lokal oder Cloud,
  Input nur aggregierte/anonyme Statistik — keine Einzeldokumente nötig).
- Output:
  - **Steuer-Sektionen** → direkt als Upserts in `tax_section_hint_overrides`
    (bestehender Mechanismus, sofort wirksam, reversibel) **oder** als Diff in
    `tax-sections.ts`. Empfehlung: erst Override-Tabelle (A/B-fähig), nach Bewährung
    in den Quelltext zurückschreiben.
  - **Taxonomie-Kategorien** → es fehlt heute ein Override-Mechanismus. Zwei Optionen:
    - (a) Hints direkt in `taxonomy.ts` zurückschreiben (versioniert, einfach, passt
      zum Einmal-Charakter) — **empfohlen**.
    - (b) Neue Tabelle `taxonomy_hint_overrides` + Merge in
      `loadTaxonomyForClassifier()` (mehr Aufwand, dafür Laufzeit-tunebar wie bei den
      Steuer-Sektionen). Nur falls du Hints langfristig ohne Deploy ändern willst.

---

## 7. Etappe E — Reliability-Hebel (optional, unabhängig)

Falls Diagnose/Eval zeigt, dass auch mit besseren Hints zu viel danebenliegt:
- **Few-Shot / Retrieval-augmented Klassifikation**: vor dem LLM-Call die k
  ähnlichsten, bereits **korrekt** (idealerweise `tax_reviewed`/`source=user`)
  eingeordneten Dokumente per Embedding ziehen und als Beispiele in den Prompt geben.
  Vollständig lokal, nutzt vorhandene Embeddings. Größter erwartbarer Sprung.
- **Modell-Upgrade**: größeres lokales GGUF (z. B. Qwen2.5-14B/32B-Instruct), falls
  das kleine Modell der Flaschenhals ist. Nur Konfig/Infra, kein Datenschutz-Thema.

Diese Etappe ist eine **dauerhafte** Verbesserung der Pipeline, kein Einmal-Job —
daher bewusst getrennt und nur bei Bedarf.

---

## 8. Etappe F — Validierung (Pflicht-Gate)

- **Gold-Set**: die `tax_reviewed=true`-Dokumente (vom Nutzer bestätigt) + die
  handgeprüften Repräsentanten.
- `08_eval.py`: klassifiziert das Gold-Set mit **alter** vs **neuer**
  Taxonomie/Hints und berichtet Top-1-Genauigkeit für Kategorie, `tax_relevant`,
  `tax_year` und Steuer-Sektion (Precision/Recall je Sektion).
- **Gate:** Änderungen an `taxonomy.ts`/Hints werden nur übernommen, wenn die neue
  Variante auf dem Gold-Set nicht schlechter ist. Ergebnis als `out/eval.md`.
- Danach: Re-Klassifikation des Korpus über die vorhandene Reclassify-Pipeline
  (Dokumente neu einreihen) — bestehende `source=user`-Zuordnungen bleiben unberührt.

---

## 9. Reihenfolge & Aufwand (Empfehlung)

| # | Etappe | Lokal/Cloud | Aufwand | Nutzen |
|---|--------|-------------|---------|--------|
| 1 | A Diagnose | lokal | ~1 Tag | entscheidet alles Weitere |
| 2 | D Hints | lokal (+ optional Cloud-Formulierung) | klein | oft schon großer Effekt, voll versionierbar |
| 3 | B+C Taxonomie | lokal + anonym. Cloud | mittel | falls Diagnose Struktur-Lücken zeigt |
| 4 | F Eval | lokal | klein, aber Pflicht-Gate | macht „besser" überprüfbar |
| 5 | E Few-Shot/Modell | lokal | mittel | dauerhafte Reliability, nur bei Bedarf |

---

## 10. Offene Punkte für deine Entscheidung

1. **Slug-Umbenennungen** in der Taxonomie: erlaubt (saubere Struktur, aber Migration
   für `document_categories` + Re-Mapping bestehender Zuordnungen nötig) — oder nur
   **additive** Änderungen (neue Unterkategorien, keine Umbenennung)?
2. **Hints-Ablage**: Steuer-Sektionen über Override-Tabelle (reversibel, A/B) oder
   direkt im Quelltext? Taxonomie-Hints Option (a) Quelltext vs (b) neue Tabelle?
3. **Cloud-Modell**: Bestätigung, dass anonymisierte Summaries an Claude gehen dürfen
   (sonst strikt lokal mit etwas gröberem Ergebnis).
4. **Re-Klassifikation**: gesamter Korpus neu einordnen, oder nur die heute
   unsicheren/`sonstiges`-Dokumente?

> Nichts in diesem Plan verändert produktive Daten. Alle Skripte sind read-only auf
> der DB; Ergebnisse sind Dateien zum Review. Übernahme erfolgt erst nach deinem OK
> und nach bestandenem Eval-Gate (Etappe F).
