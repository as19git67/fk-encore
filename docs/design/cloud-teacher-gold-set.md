# Design: Cloud-Lehrer zum automatischen Wachsen des Gold-Sets

**Status:** Entwurf zur Diskussion — noch kein Code.
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

**Regler statt Alles-oder-nichts:** Institutionelle Absendernamen (Comdirect,
HALLESCHE, Finanzamt) sind **keine** PII. Man kann sie behalten und nur
personenbezogene Daten strippen — dann kann Claude auch Absender + Kategorie
deutlich zuverlässiger lehren, bei kaum erhöhtem Privacy-Risiko. Empfehlung:
eigene, **weniger aggressive** Scrub-Stufe für den Lehrer (Personen/IBAN/Beträge
raus, institutioneller Absender bleibt), getrennt von der strengen Audit-Stufe.

## 4. Privacy-Entscheidung (bewusst zu treffen)

Der bisherige Cloud-Zugriff ist ein **einmaliger Sample-Audit** mit
Dry-Run-Review des Scrubbings. Ein **wiederkehrender** Lehrer-Batch über Teile
des Bestands ist eine andere Posture. Punkte:

- Der Scrubber ist regex-basiert und **best-effort** (er hat sogar
  Adressfragmente wie „merching"/„86504" hart codiert). Für einen Batch okay;
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

### 5.2 Persistenz (WO landen die Labels?)

Neue Herkunfts-Markierung, klar getrennt von KI-Rohoutput und echten
Nutzer-Reviews:

- Kategorie: eine Spalte/Tabelle, die „diese Kategorie ist cloud-bestätigt"
  ausdrückt — z. B. `documents.category_source = 'cloud'` **oder** ein
  `attributes_reviewed`-Äquivalent `attributes_cloud_verified`. Wichtig: **nicht**
  einfach `attributes_reviewed=true` setzen, damit man „echt manuell" von
  „cloud-gelabelt" unterscheiden kann (Vertrauensstufen).
- Steuer: `document_tax_sections.source = 'cloud'` (Enum erweitern; heute
  `'ai' | 'user'`).

Damit bleibt die Semantik sauber dreistufig: `ai` (Roh-Qwen) < `cloud`
(Claude-bestätigt) < `user` (manuell).

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

### 5.4 Abgrenzung zu den deterministischen Regeln

Der Cloud-Lehrer **ersetzt** die deterministischen Regeln (Sender-/Content-/
Steuer-Regeln) **nicht**. Die Regeln bleiben der billige, sofortige Fix für
**bekannte systematische** Fehler. Der Lehrer adressiert den **unbekannten
langen Schwanz**, den man nicht per Hand als Regel fassen kann. Sie ergänzen
sich.

## 6. Kosten & Betrieb

- Nur eine **Teilmenge** geht an Claude (dünne Zweige + neue + strittige Docs),
  nicht der ganze Korpus und nicht bei jedem Reclassify. Das begrenzt Kosten und
  Rate-Limit-Druck.
- Rate-Limit-Robustheit ist im Audit-Tool bereits vorhanden (Backoff,
  Teilergebnis, `AUDIT_REQUEST_DELAY`) und würde wiederverwendet.
- Wiederkehrend als manueller Batch oder Cron; Ergebnis ist ein Datenbank-Update
  der `cloud`-Labels, kein Laufzeitpfad.

## 7. Offene Fragen (vor Implementierung zu klären)

1. **Scrub-Stufe für den Lehrer:** institutionellen Absender behalten (mehr
   Signal) oder strikt wie das Audit (max. Datensparsamkeit)?
2. **Vertrauensstufe:** separater `cloud`-Marker (empfohlen) oder direkt als
   `reviewed` behandeln?
3. **Auto-Anwendung vs. Vorschlag:** Claude-Label direkt als `category_source=
   'cloud'` schreiben, oder in eine Review-Queue legen, die du stichprobenartig
   abnickst? (Kompromiss: hohe Claude-Confidence auto-anwenden, Rest in die
   Queue.)
4. **Umfang pro Lauf / Budget-Deckel.**
5. **Regressionsschutz:** Wenn `cloud`-Labels Learned-Rules speisen und eine
   davon später falsch ist, wie einfach lässt sich das rückgängig machen?
   (Vorschlag: `cloud`-Herkunft macht das trivial filter-/löschbar.)

## 8. Empfohlener nächster Schritt

Kein Code, bevor Frage 1–3 entschieden sind. Danach ein kleiner, isolierter
erster Schritt: **`cloud`-Herkunft in Schema + Scrub-Stufe** einführen und einen
`teacher`-Modus im bestehenden `cloud_audit.py` (bzw. einem Schwester-Skript),
der eine dünn besetzte Kategorie labelt und als `cloud` persistiert — messbar
über den nächsten Diagnose-/Audit-Lauf, bevor die Einspeisung in Few-Shot/
Learned-Rules scharf geschaltet wird.
