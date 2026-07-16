# Design: Cloud-Lehrer zum automatischen Wachsen des Gold-Sets

**Status:** Schritte 1–3 umgesetzt (Persistenz-Schicht, noch ohne Wirkung auf
die Klassifikation). Schritte 4–5 (runClassify-Guards, Few-Shot/Learned-Rules-
Filter, Messung) folgen nach Sichtprüfung der ersten `cloud`-Labels.
**Autor-Kontext:** Folgt aus der Steuer-/Kategorie-Audit-Serie (Juli 2026).

## 1. Ziel und Abgrenzung (wichtig)

**Was das ist:** Ein Mechanismus, der den Anteil **vertrauenswürdig gelabelter
Dokumente** automatisch erhöht, indem ein starkes Cloud-Modell (Claude) eine
**strategische Auswahl** von Dokumenten labelt — mit PII-Scrubbing wie im
bestehenden `cloud_audit.py`. Diese Labels ersetzen die **manuelle**
Klassifikation, die heute das Gold-Set / die „reviewed"-Beispiele speist.

**Was das ausdrücklich NICHT ist:** Kein Ersatz der Produktions-Klassifikation.
Es werden **nicht** künftig alle Dokumente per Claude-API klassifiziert. Das
lokale Qwen bleibt der Klassifikator für jedes Dokument. Claude läuft nur
gezielt und offline, um dort **mehr korrekte Beispiele** zu erzeugen, wo es
heute zu wenige gibt.

**Motivation (O-Ton des Nutzers):** „…nur den Anteil der ‚manuell'
klassifizierten zu erhöhen, um vielleicht auch in Bereichen mehr korrekt
klassifizierte Dokumente zu haben, wo es heute noch zu wenig sind." Genau das:
die Stellen, an denen man sonst sagen würde „das Ergebnis wäre besser, wenn du
mehr manuell klassifiziert hättest", füllt Claude automatisch auf.

## 2. Warum das hilft — die bestehenden Mechanismen honorieren „reviewed"

Der lokale Pipeline verbessert sich schon heute an zwei Stellen, wenn es mehr
**menschlich bestätigte** Beispiele gibt:

- **Few-Shot** (`documents/few-shot.ts`): ankert das kleine Modell an den
  nächsten bereits klassifizierten Dokumenten desselben Haushalts und
  bevorzugt/filtert dabei `attributes_reviewed = true` (Reviewed-only-Modus).
- **Learned-Rules** (`documents/learned-rules.ts`): leitet deterministische
  Sender→Kategorie/Steuer/Tag/Bezugsperson-Overrides aus den vom Menschen
  bestätigten Dokumenten ab (Schwellen: ≥3 geprüfte Dok. + ≥75 % Dominanz für
  Kategorie, ≥2 für die übrigen).

Beide sind heute durch die **Menge manueller Reviews** begrenzt (aktuell ~74
`attributes_reviewed`, ~109 `tax_reviewed`). Claude-Labels, die als
vertrauenswürdig markiert werden, heben genau diese Grenze — ohne manuellen
Aufwand.

## 3. Der entscheidende Haken: Scrubbing begrenzt, WAS Claude lehren kann

Das Audit-Scrubbing (`scripts/taxonomy/_common.py`) entfernt IBANs, Beträge,
**Daten**, Telefon, lange Nummern, Adressen, Personennamen und reduziert den
**Absender auf einen Typ** („Bank/Broker", „Versicherung", …). Damit gehen genau
die Signale verloren, die für einige Felder nötig sind:

| Feld | Braucht Rohdaten? | Cloud-Lehrer geeignet? |
|---|---|---|
| `category_slug` | robust ggü. Scrubbing | **Ja** |
| `tax_relevant` / `tax_sections` | robust | **Ja** |
| `sender` | Klarname nötig | **Nein** (scrubbed) |
| `doc_date` / `tax_year` | echtes Datum nötig | **Nein** (scrubbed) |
| `document_number` | „#1234" nötig | **Nein** (scrubbed) |

**Konsequenz:** Der Cloud-Lehrer liefert vertrauenswürdige Labels **nur für die
Kategorie- und Steuer-Achse**. Absender/Datum/Nummer/Steuerjahr bleiben beim
lokalen Pipeline + den deterministischen Extraktoren. Ein „vollständig korrekt
klassifiziert per Claude" ist mit aggressivem Scrubbing technisch nicht möglich —
das Scrubbing nimmt dem Modell die Signale dafür.

**Entscheidung:** Institutionelle Absendernamen (Comdirect, HALLESCHE,
Finanzamt) sind **keine** PII und bleiben im Klartext — nur personenbezogene
Daten werden gestrippt. Das gibt Claude ein stärkeres Signal für Absender- und
Kategorie-Zuordnungen, bei kaum erhöhtem Privacy-Risiko. Der Lehrer bekommt eine
eigene, **weniger aggressive** Scrub-Stufe (Personennamen/IBAN/Beträge/Daten
raus, institutioneller Absender bleibt), getrennt von der strengen Audit-Stufe
(`_scrub_for_teacher()` als eigene Funktion neben `scrub()`/`scrub_names()` in
`_common.py`, nicht als Parameter der bestehenden — die Audit-Stufe bleibt
unverändert streng).

## 4. Privacy-Entscheidung (bewusst zu treffen)

Der bisherige Cloud-Zugriff ist ein **einmaliger Sample-Audit** mit
Dry-Run-Review des Scrubbings. Ein **wiederkehrender** Lehrer-Batch über Teile
des Bestands ist eine andere Posture. Punkte:

- Der Scrubber ist regex-basiert und **best-effort** (er hat sogar
  Adressfragmente wie „beispielstadt"/„12345" hart codiert). Für einen Batch okay;
  vor einem Dauerbetrieb sollte man das Scrubbing härten/prüfen.
- **Dry-Run-Pflicht:** Jeder Lehrer-Lauf sollte im `AUDIT_DRY_RUN`-Stil erst die
  exakt zu sendenden (gescrubbten) Prompts nach `out/` schreiben, damit man vor
  dem Absenden stichprobenartig prüfen kann.
- Datensparsamkeit: nur Titel/Text/Absender-Typ/Tags gehen raus (wie heute),
  keine Roh-PDFs.

Das ist eine Entscheidung, die bewusst getroffen werden muss — sie wird hier
offengelegt, nicht implizit mitgeliefert.

## 5. Vorgeschlagene Architektur

### 5.1 Auswahl (WELCHE Dokumente labelt Claude?)

Nicht confidence-basiert — Qwen ist überkonfident (0,95 auch wenn falsch). Statt
dessen gezielt dort, wo das Gold-Set dünn oder Qwen systematisch schwach ist:

1. **Dünn besetzte Kategorien/Sektionen** — Zweige mit sehr wenigen (oder null)
   `reviewed`-Beispielen (z. B. die Long-Tail-Kategorien mit 1–5 Dokumenten, die
   im Diagnose-Report sichtbar sind).
2. **Bekannte Streit-Achsen** — z. B. `altersvorsorge-lebensversicherung` ↔
   `-rentenversicherung`, `finanzen-steuern`, Immobilien-Sektionen.
3. **Neue Dokumente** seit dem letzten Lauf.
4. Optional: Dokumente, bei denen deterministische Regeln (Sender/Content) und
   LLM sich uneinig sind.

Deduplizieren gegen bereits gelabelte (wie `picked_ids` im Audit).

### 5.2 Persistenz (WO landen die Labels?) — entschieden: separater `cloud`-Marker

Neue Herkunfts-Markierung, klar getrennt von KI-Rohoutput und echten
Nutzer-Reviews — **nicht** einfach als `attributes_reviewed=true`/`user`
verbucht, damit ein späterer Widerspruch (z. B. nächstes Audit) gezielt
zurückgenommen werden kann, ohne echte manuelle Reviews zu berühren:

- Kategorie: `documents.category_source` (neue Spalte, `'ai' | 'cloud' | 'user'`,
  Default `'ai'`) statt des reinen Booleans `attributes_reviewed`. Category-Fix
  bleibt geschützt (`runClassify` überschreibt nicht, wenn `category_source IN
  ('cloud','user')` — analog zum bisherigen `attributes_reviewed`-Guard).
- Steuer: `document_tax_sections.source` Enum um `'cloud'` erweitern (heute
  `'ai' | 'user'`).
- Tags/Bezugspersonen: gleiches Muster bei Bedarf, `source='cloud'` auf den
  bestehenden `'ai' | 'user'`-Spalten (`document_tag_links`,
  `document_subject_persons`).

Damit bleibt die Semantik sauber dreistufig: `ai` (Roh-Qwen) < `cloud`
(Claude-bestätigt) < `user` (manuell). **Regressionsschutz:** genau wegen dieser
Trennung ist ein Rücknehmen trivial — `DELETE ... WHERE source='cloud'` (bzw.
`category_source` zurück auf `'ai'` setzen) fällt automatisch auf die
Roh-Qwen-Werte zurück, kein Sonderfall nötig. Kein zusätzlicher Batch-Zeitstempel
geplant — die vorhandenen `created_at`-Spalten reichen für Nachvollziehbarkeit.

### 5.3 Einspeisung (WIE verbessert es das lokale Modell?)

Ohne neue ML-Infrastruktur, über die **bestehenden** Pfade:

- **Few-Shot:** `cloud`-verifizierte Dokumente als vertrauenswürdige Anker
  zulassen (den Reviewed-only-Filter auf `reviewed OR cloud` erweitern).
- **Learned-Rules:** die Ground-Truth-Basis von „nur `reviewed`/`user`" auf
  „`reviewed`/`user` **oder** `cloud`" erweitern. Da die Schwellen (≥3, ≥75 %)
  erhalten bleiben, entstehen daraus weiterhin nur robuste Overrides.

Wirkung: mehr vertrauenswürdige Beispiele → mehr Few-Shot-Deckung und mehr
gelernte Sender-Overrides → das **freie** lokale Modell wird besser, dauerhaft,
ohne Cloud-Call zur Laufzeit.

### 5.5 Übernahme — entschieden: direkt automatisch

Claude-Opus-Labels werden **ohne Zwischenschritt** mit `source='cloud'` /
`category_source='cloud'` persistiert — kein Review-Queue-Umweg, das wäre
gegen den Zweck der Idee (Ersatz für manuelles Klassifizieren). Begründung:
Claude Opus ist in den bisherigen Audits als Klassifikator sehr zuverlässig
(Kategorie- und Steuer-Urteile deckten sich mit sorgfältiger Einzelprüfung).
Der Regressionsschutz aus 5.2 fängt den seltenen Fehlerfall ab.

### 5.4 Abgrenzung zu den deterministischen Regeln

Der Cloud-Lehrer **ersetzt** die deterministischen Regeln (Sender-/Content-/
Steuer-Regeln) **nicht**. Die Regeln bleiben der billige, sofortige Fix für
**bekannte systematische** Fehler. Der Lehrer adressiert den **unbekannten
langen Schwanz**, den man nicht per Hand als Regel fassen kann. Sie ergänzen
sich.

## 6. Kosten & Betrieb — entschieden: ~300–500 Dokumente pro Lauf

- Batch-Größe pro Lehrer-Lauf: **~300–500 Dokumente**, aus dünnen Zweigen +
  neuen Dokumenten + bekannten Streit-Achsen (5.1), nicht der ganze Korpus und
  nicht bei jedem Reclassify.
- Braucht die Rate-Limit-Härtung aus PR #847 zwingend (Backoff, Teilergebnis
  bei Abbruch, `AUDIT_REQUEST_DELAY`) — bei dieser Größenordnung wird `429`
  ohne sie zum Normalfall, nicht zur Ausnahme.
- Wiederkehrend als manueller Batch oder Cron; Ergebnis ist ein
  Datenbank-Update der `cloud`-Labels, kein Laufzeitpfad.

## 7. Entscheidungen (final)

1. **Scrub-Stufe:** institutioneller Absender bleibt im Klartext, nur
   personenbezogene Daten werden gestrippt (eigene, mildere Scrub-Funktion
   für den Lehrer, s. 3).
2. **Vertrauensstufe:** separater `cloud`-Marker (`category_source` /
   `source='cloud'`), nie mit `reviewed`/`user` vermischt.
3. **Übernahme:** direkt automatisch, keine Review-Queue.
4. **Umfang pro Lauf:** ~300–500 Dokumente.
5. **Regressionsschutz:** die `cloud`-Herkunft selbst reicht (löschbar/
   filterbar), kein zusätzlicher Batch-Zeitstempel.

## 8. Nächster Schritt

Schritte 1–3 sind umgesetzt (isolierte Persistenz-Schicht):

1. ✅ Schema (Migration `0132_document_cloud_source`): neue Spalte
   `documents.category_source` (Enum `document_category_source`
   `'ai' | 'cloud' | 'user'`, Default `'ai'`, Backfill `'user'` wo
   `attributes_reviewed`), Enum `document_tax_source` um `'cloud'` erweitert.
   `document_tag_links.source`/`document_subject_persons.source` sind TEXT und
   akzeptieren `'cloud'` bereits — nur die Drizzle-`$type`-Annotationen wurden
   geweitet (kein DDL).
2. ✅ `_common.py`: `scrub_for_teacher()` — mildere Scrub-Stufe, lässt den
   institutionellen Absender im Klartext, entfernt aber dieselbe PII wie der
   Audit. Die strenge Audit-Stufe (`scrub`/`scrub_names`) bleibt unverändert.
3. ✅ `scripts/taxonomy/cloud_teacher.py`: eigener Lehrer-Modus. Auswahl nach
   5.1 (dünne Zweige + Streit-Achsen + neue Dokumente), schreibt direkt mit
   `source='cloud'` / `category_source='cloud'` in die DB. Fasst
   `user`/`reviewed`-Werte nie an. `TEACHER_DRY_RUN` (bzw. `AUDIT_DRY_RUN`)
   schreibt nur die gescrubbten Prompts nach `out/` zur Kontrolle. Schreibt
   einen Vorher/Nachher-Report (`out/cloud_teacher.md` +
   `cloud_teacher_labels.json`) für die Sichtprüfung.

Offen (bewusst noch nicht umgesetzt, damit die Persistenz erst isoliert
geprüft werden kann):

4. `runClassify`-Guards (auf `category_source` statt nur `attributes_reviewed`)
   und Few-Shot-/Learned-Rules-Filter auf `cloud` erweitern (5.2/5.3). Bis
   dahin überschreibt ein normaler Reclassify die `cloud`-Kategorie wieder —
   die Labels sind bis Schritt 4 nur zur Inspektion da. Auch die Frontend-
   Badges (`source === 'ai'`) behandeln `'cloud'` erst mit Schritt 4 eigen.
5. Messen: Diagnose-/Audit-Lauf vorher/nachher, um die Wirkung auf dünn
   besetzte Zweige zu quantifizieren.

Empfehlung bleibt: Schritt 4 erst nach Sichtprüfung der ersten `cloud`-Labels.
