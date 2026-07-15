# Tax Document Detection — Feature-Plan

Ziel: Beim automatischen Klassifizieren eines Dokuments soll die KI zusätzlich
erkennen (a) **ob** das Dokument für die deutsche Einkommensteuererklärung
relevant ist, (b) für **welches Steuerjahr** und (c) welcher **Anlage /
welchem Abzugsbereich** es zuzuordnen ist. Das Frontend bekommt eine
"Steuer"-Ansicht, die alle als steuerrelevant markierten Dokumente nach
Steuerjahr und Anlage gruppiert anzeigt ("ein Klick → alle Belege für 2025
nach Anlagen sortiert").

Status: Feature-Plan, Umsetzung in Etappen.

---

## 1. Recherche: deutsche Einkommensteuer — Anlagen & Abzugsbereiche

Die Einkommensteuererklärung besteht aus dem **Hauptvordruck (Mantelbogen)**
für persönliche Daten und thematischen **Anlagen**. Jeder Beleg gehört genau
einer Hauptanlage (Werbungskosten können aber innerhalb von Anlage N, V, KAP,
R vorkommen — deshalb zusätzlich ein Subtyp).

### 1.1 Einkünfte-Anlagen (Einnahmen)

| Slug            | Anlage / Formular         | Typische Belege                                                                 |
|-----------------|---------------------------|---------------------------------------------------------------------------------|
| `anlage-n`      | Anlage N                  | Lohnsteuerbescheinigung, Arbeitgeberbescheinigung, Lohn-/Gehaltsabrechnungen    |
| `anlage-kap`    | Anlage KAP                | Jahressteuerbescheinigung der Bank/Broker, Dividenden, Zinsabrechnungen         |
| `anlage-v`      | Anlage V (Vermietung)     | Mieteinnahmen-Nachweise, Nebenkostenabrechnungen (Vermieter), WEG-Abrechnungen  |
| `anlage-r`      | Anlage R (Renten)         | Rentenbezugsmitteilung Deutsche Rentenversicherung, private Rentenauszahlungen  |
| `anlage-r-aus`  | Anlage R-AUS              | Ausländische Renten                                                             |
| `anlage-r-av`   | Anlage R-AV/bAV           | Leistungen aus bAV / Riester-Auszahlungen                                       |
| `anlage-g`      | Anlage G (Gewerbe)        | Gewerbeeinkünfte, Bilanzen                                                      |
| `anlage-s`      | Anlage S (Selbstständig)  | Einkünfte aus freiberuflicher/selbstständiger Arbeit                            |
| `anlage-euer`   | Anlage EÜR                | Einnahmenüberschussrechnung (gehört zu G oder S)                                |
| `anlage-so`     | Anlage SO                 | Sonstige Einkünfte (private Veräußerungen, Unterhaltsempfang)                   |

### 1.2 Abzugs-Anlagen (Ausgaben → mindern Steuer)

| Slug                    | Anlage / Kategorie                | Typische Belege                                                                  |
|-------------------------|-----------------------------------|----------------------------------------------------------------------------------|
| `werbungskosten-n`      | Werbungskosten (Anlage N)         | Fahrtkostennachweise, Fortbildungen, Arbeitsmittel, Arbeitszimmer, Reisekosten   |
| `werbungskosten-v`      | Werbungskosten (Anlage V)         | Reparaturen Mietobjekt, Grundsteuer Mietobjekt, Hausgeld, Darlehenszinsen        |
| `werbungskosten-kap`    | Werbungskosten (Anlage KAP)       | (selten, nur Sonderfälle)                                                        |
| `werbungskosten-r`      | Werbungskosten (Anlage R)         | Steuerberatungskosten Rentner, Rentenberatungskosten                             |
| `sonderausgaben`        | Sonderausgaben                    | Spendenquittungen, Kirchensteuer, Unterhaltsleistungen (§10), Steuerberatung     |
| `vorsorgeaufwand`       | Anlage Vorsorgeaufwand            | Krankenkassenbeiträge, Pflegeversicherung, Rürup, Haftpflicht, Unfallversicherung|
| `anlage-av`             | Anlage AV (Riester)               | Riester-Vertrag-Bescheinigung, Zulagenantrag                                     |
| `aussergewoehnliche`    | Außergewöhnliche Belastungen      | Krankheitskosten, Zahnarzt, Medikamente (Rezept), Pflegeheim, Kur, Beerdigung    |
| `haushaltsnahe`         | Haushaltsnahe Dienstleistungen/Handwerker (§35a) | Rechnungen Putzkraft, Gartenarbeiten, Handwerker (Lohnanteil) + Kontobeleg |
| `anlage-kind`           | Anlage Kind                       | Geburtsurkunde, Kindergeldnachweis, Schulbescheinigung, Kinderbetreuungskosten   |
| `anlage-unterhalt`      | Anlage Unterhalt                  | Unterhaltszahlungen an bedürftige Personen                                       |
| `anlage-energetisch`    | Anlage Energetische Maßnahmen (§35c) | Rechnungen & Bescheinigung für energetische Sanierung selbst genutzter Immobilie |

### 1.3 Bescheid / Rahmen

| Slug                    | Kategorie                         | Typische Belege                                        |
|-------------------------|-----------------------------------|--------------------------------------------------------|
| `steuerbescheid`        | Finanzamtsbescheid (kein Beleg)   | Einkommensteuerbescheid, Vorauszahlungs-Bescheid       |
| `mantelbogen`           | Stammdaten / Persönliches         | Heiratsurkunde, Adressnachweis (meist nicht nötig)     |

Die Liste ist bewusst eng an den realen ELSTER-/Finanzamts-Anlagen orientiert,
weil die Ausgabe des Features eine **druckbare Ablage-Liste pro Anlage** sein
soll (Anwender:in kann mit dem Papierstapel in die Steuererklärung gehen).

---

## 2. Domänen-Konstanten (`documents/tax-sections.ts`, neu)

```ts
export const TAX_SECTIONS = [
  { slug: "anlage-n",            group: "einkuenfte",   name: "Anlage N — Nichtselbstständige Arbeit" },
  { slug: "anlage-kap",          group: "einkuenfte",   name: "Anlage KAP — Kapitalerträge" },
  { slug: "anlage-v",            group: "einkuenfte",   name: "Anlage V — Vermietung & Verpachtung" },
  { slug: "anlage-r",            group: "einkuenfte",   name: "Anlage R — Renten" },
  { slug: "anlage-r-aus",        group: "einkuenfte",   name: "Anlage R-AUS — Ausländische Renten" },
  { slug: "anlage-r-av",         group: "einkuenfte",   name: "Anlage R-AV/bAV" },
  { slug: "anlage-g",            group: "einkuenfte",   name: "Anlage G — Gewerbe" },
  { slug: "anlage-s",            group: "einkuenfte",   name: "Anlage S — Selbstständige Arbeit" },
  { slug: "anlage-euer",         group: "einkuenfte",   name: "Anlage EÜR" },
  { slug: "anlage-so",           group: "einkuenfte",   name: "Anlage SO — Sonstige Einkünfte" },

  { slug: "werbungskosten-n",    group: "abzuege",      name: "Werbungskosten (Anlage N)" },
  { slug: "werbungskosten-v",    group: "abzuege",      name: "Werbungskosten (Anlage V)" },
  { slug: "werbungskosten-kap",  group: "abzuege",      name: "Werbungskosten (Anlage KAP)" },
  { slug: "werbungskosten-r",    group: "abzuege",      name: "Werbungskosten (Anlage R)" },
  { slug: "sonderausgaben",      group: "abzuege",      name: "Sonderausgaben" },
  { slug: "vorsorgeaufwand",     group: "abzuege",      name: "Anlage Vorsorgeaufwand" },
  { slug: "anlage-av",           group: "abzuege",      name: "Anlage AV — Altersvorsorge (Riester)" },
  { slug: "aussergewoehnliche",  group: "abzuege",      name: "Außergewöhnliche Belastungen" },
  { slug: "haushaltsnahe",       group: "abzuege",      name: "Haushaltsnahe Aufwendungen / §35a" },
  { slug: "anlage-kind",         group: "abzuege",      name: "Anlage Kind" },
  { slug: "anlage-unterhalt",    group: "abzuege",      name: "Anlage Unterhalt" },
  { slug: "anlage-energetisch",  group: "abzuege",      name: "Energetische Maßnahmen §35c" },

  { slug: "steuerbescheid",      group: "bescheid",     name: "Steuerbescheid" },
  { slug: "mantelbogen",         group: "rahmen",       name: "Mantelbogen / Stammdaten" },
] as const;

export type TaxSectionSlug = typeof TAX_SECTIONS[number]["slug"];
export type TaxSectionGroup = "einkuenfte" | "abzuege" | "bescheid" | "rahmen";
```

Die Enum liegt bewusst als TS-Konstante (nicht als DB-Tabelle): klein,
versionskontrolliert, einfach erweiterbar; die KI bekommt die Liste pro
`/classify`-Call als Teil des Prompts genauso wie heute die Kategorien-
Taxonomie.

---

## 3. DB-Migration `0029_tax_fields.sql`

Ergänzt drei Spalten zur `documents`-Tabelle und einen Index für die
Gruppierungs-Query. Keine neue Tabelle nötig.

```sql
ALTER TABLE documents
  ADD COLUMN tax_relevant          boolean NOT NULL DEFAULT false,
  ADD COLUMN tax_year              integer,
  ADD COLUMN tax_section           text,
  ADD COLUMN tax_confidence        real,
  ADD COLUMN tax_user_confirmed    boolean NOT NULL DEFAULT false;

-- Wertebereich-Check (defensiv; schützt vor KI-Ausrutschern)
ALTER TABLE documents
  ADD CONSTRAINT documents_tax_year_range
    CHECK (tax_year IS NULL OR (tax_year BETWEEN 2000 AND 2100));

CREATE INDEX documents_tax_idx
  ON documents (tax_relevant, tax_year, tax_section)
  WHERE tax_relevant = true;
```

Entsprechende Änderung in `db/schema.ts` (Drizzle):

```ts
tax_relevant:       boolean("tax_relevant").notNull().default(false),
tax_year:           integer("tax_year"),
tax_section:        text("tax_section"),          // TaxSectionSlug oder null
tax_confidence:     real("tax_confidence"),
tax_user_confirmed: boolean("tax_user_confirmed").notNull().default(false),
```

`tax_user_confirmed` unterscheidet User-bestätigte Werte von KI-Vorschlägen
(wie `classification_confidence` → UI zeigt "KI-Vorschlag" mit Bestätigen-
Button).

---

## 4. LLM-Service (`llm-service/main.py`)

Zwei kleine Anpassungen, kein neues Endpoint nötig.

**4.1 Response-Schema erweitern** (`ClassifyResponse`):

```py
class ClassifyResponse(BaseModel):
    category_slug: str
    title: str
    doc_date: str | None = None
    sender: str | None = None
    summary: str
    tags: list[str]
    confidence: float = Field(..., ge=0.0, le=1.0)
    # Neu:
    tax_relevant: bool = False
    tax_year: int | None = None
    tax_section: str | None = None     # slug aus TAX_SECTIONS
    tax_confidence: float = Field(0.0, ge=0.0, le=1.0)
```

**4.2 Request um `tax_sections` erweitern** (Encore ts übergibt Liste), und
System-Prompt anhängen:

```text
STEUER-ERKENNUNG
Beurteile zusätzlich, ob das Dokument als Beleg für die deutsche
Einkommensteuererklärung dient.

- tax_relevant: true, wenn das Dokument üblicherweise als Beleg oder
  Bescheinigung für die Steuererklärung vorgelegt oder aufbewahrt wird
  (Lohnsteuerbescheinigung, Spendenquittung, Handwerkerrechnung mit
  Lohnanteil, Krankheitskosten, Kapitalerträge, Vermietungsbelege, …).
  false bei rein privaten Belegen ohne Steuerbezug (Supermarktkassenbon,
  Werbung, privater Schriftverkehr, …).
- tax_year: vierstelliges Kalenderjahr, für das der Beleg steuerlich zählt.
    * Bei Jahresbescheinigungen (z.B. "Jahressteuerbescheinigung 2024"): das
      genannte Jahr.
    * Bei Einzelrechnungen: das Jahr des Leistungs-/Zahlungsdatums
      (Zuflussprinzip).
    * Bei einer land-/forstwirtschaftlichen Gewinnermittlung für das
      abweichende Wirtschaftsjahr 01.07.JJJJ–30.06.FOLGEJAHR: JJJJ. Diese
      Startjahr-Regel gilt nur für Land- und Forstwirtschaft; andere
      betriebliche EÜR werden dem Endjahr zugeordnet. Eine deterministische
      Nachprüfung sichert diese Abgrenzung zusätzlich zum LLM-Prompt ab.
    * Bei Unsicherheit: null.
- tax_section: der passendste Slug aus der gegebenen Steuerabschnitts-Liste
  oder null, wenn tax_relevant=false oder die Zuordnung unsicher ist.
- tax_confidence: 0..1, dein Vertrauen in die Steuer-Zuordnung
  (unabhängig von confidence der Hauptkategorie).
```

Der Prompt listet dann alle `TAX_SECTIONS` (slug + name) nach Gruppe auf,
genau wie heute die Kategorien-Taxonomie.

**4.3 Tokens**: `max_tokens` von 512 → 640 erhöhen (vier neue Felder).
Der Kontext (6000 Zeichen Text + Taxonomie + Tax-Liste) bleibt im Rahmen.

**4.4 Tests** (`llm-service/tests/`): neuer Fixture-Test, der mit einem
Mock-LLM prüft, dass `ClassifyResponse` Tax-Felder durchreicht und
Default-Werte korrekt sind.

---

## 5. Encore-Service (`documents/`)

**5.1 `llm-client.ts`** — Types um Tax-Felder erweitern:

```ts
export interface Classification {
  category_slug: string;
  title: string;
  doc_date: string | null;
  sender: string | null;
  summary: string;
  tags: string[];
  confidence: number;
  tax_relevant: boolean;
  tax_year: number | null;
  tax_section: string | null;
  tax_confidence: number;
}
```

`parseClassification()` validiert die neuen Felder (tax_year nur wenn ganz­zahlig
2000..2100, tax_section nur wenn in `TAX_SECTIONS`, sonst null).

**5.2 `document-ops.ts:runClassify`** — persistiert zusätzlich:

```ts
tax_relevant:   classification.tax_relevant,
tax_year:       classification.tax_year,
tax_section:    classification.tax_section,
tax_confidence: classification.tax_confidence,
// tax_user_confirmed bleibt false
```

**5.3 Neue Endpoints in `documents.ts`**:

- `GET /documents/tax/years` → `{ years: number[] }` — DISTINCT `tax_year`
  über alle steuerrelevanten Dokumente des Users (für Dropdown).
- `GET /documents/tax?year=2025` → gruppierte Liste:
  ```ts
  interface TaxYearOverview {
    year: number;
    groups: Array<{
      section: TaxSectionSlug;
      section_name: string;
      group: TaxSectionGroup;
      documents: DocumentSummary[];
    }>;
    unassigned: DocumentSummary[];  // tax_relevant=true, tax_section=null
  }
  ```
  Sortiert: zuerst `einkuenfte`, dann `abzuege`, dann `bescheid`.
- `POST /documents/:id/tax` — manuelles Überschreiben durch den User:
  ```ts
  { tax_relevant?: boolean; tax_year?: number | null; tax_section?: TaxSectionSlug | null }
  ```
  setzt `tax_user_confirmed = true`.
- `listDocuments` um Filter erweitern: `tax_relevant?: boolean`,
  `tax_year?: number`, `tax_section?: TaxSectionSlug`.

**5.4 Backfill-Script** (`documents/backfill-tax.ts`, one-shot):
Requeued alle bestehenden `ready`-Dokumente in eine `classify`-Job, damit die
KI auch Altbestand mit Tax-Feldern anreichert. Alternativ: nur-Tax-Job
(`runClassifyTaxOnly`), der den `extracted_text` neu durch den LLM schickt,
aber nur die Tax-Felder aktualisiert (spart Tokens).

---

## 6. Frontend (`frontend/src/views/`)

**6.1 Neue Route `/documents/steuer`** → `TaxView.vue`:

- Oben: Dropdown **Steuerjahr** (Default: aktuelles Jahr − 1), Toggle "auch
  unbestätigte KI-Vorschläge anzeigen", Button "Checkliste als PDF/Druck".
- Darunter: pro `group` eine Section ("Einkünfte", "Abzüge", "Bescheide"),
  pro `tax_section` ein aufklappbares Panel mit Doc-Liste (Dateiname,
  Absender, Datum, Betrag falls vorhanden, Confidence-Badge falls
  KI-Vorschlag).
- Unassigned-Bucket am Ende ("Steuerrelevant, aber Anlage unklar — bitte
  prüfen").

**6.2 `DocumentDetailView.vue`** — neue Karte "Steuer":

- Toggle `Steuerrelevant`
- Zahlenfeld `Steuerjahr`
- Select `Anlage / Abzugsbereich` (gruppiert nach group)
- KI-Badge "Vorschlag (72%)" solange `tax_user_confirmed=false`;
  Button "Übernehmen" setzt `tax_user_confirmed=true`.

**6.3 `DocumentsView.vue`** — neue Filter-Chips: `Steuer 2024`, `Steuer 2025`
(nur sichtbar wenn Jahre existieren). Klick setzt `tax_relevant=true` +
`tax_year=X`.

**6.4 Navigation** — Menüpunkt "Dokumente" bekommt Untereintrag "Steuer".

---

## 7. Etappen (so lasse ich commiten)

1. **Schema & Enum** — Migration 0029, `schema.ts`, `tax-sections.ts`,
   Drizzle-Typen. Grün durch `drizzle-kit check` und bestehende Tests.
2. **LLM-Prompt & Client-Types** — `llm-service/main.py` erweitern,
   `llm-client.ts` Typ + Parser, Python-Test + TS-Unit-Test für Parser.
3. **Persistenz & Backfill** — `runClassify` schreibt Tax-Felder;
   Backfill-Script; manuelle Override-Endpoints.
4. **Listing-/Gruppierungs-API** — `/documents/tax` + `/tax/years` +
   Filter-Query-Params; Encore-Tests.
5. **Frontend Tax-View** — neue Route, Detail-Karte, Filter-Chips,
   Print-Layout.
6. **QA-Durchgang** — echte Beispielbelege (Lohnsteuerbescheinigung,
   Handwerkerrechnung, Spendenquittung, Arztrechnung, Jahressteuer-
   bescheinigung) durch die Pipeline; manuelles Review der KI-Zuordnung,
   Schwellenwert `tax_confidence < 0.7` → UI-Hinweis "bitte bestätigen".

---

## 8. Entschiedene Fragen

1. **Mehrere Sektionen pro Dokument**: **N:M** über Join-Tabelle
   `document_tax_sections`. Begründung: reale Belege passen häufig in
   mehrere Anlagen (Handwerker am Mietobjekt = Anlage V + ggf. §35a,
   Lohnabrechnung = Anlage N + §35a für Versorgungsleistungen, …).
2. **Betragsextraktion**: Erst in **Iteration 2**. Iteration 1 liefert
   nur Klassifikation; der Druckauszug nennt „Betrag lt. Beleg" —
   Nutzer:in trägt selbst in ELSTER ein.
3. **`werbungskosten-*` feingranular**: Pro Anlage ein eigener Slug
   (N/V/KAP/R). Fallback der KI: wenn unsicher → `werbungskosten-n`
   (häufigster Fall) mit niedriger Confidence.
4. **Datenschutz / Retention**: Steuerbelege müssen in DE ≥ 2 Jahre
   (privat, Einkommensteuer) bis 10 Jahre (Vermieter/Selbstständig)
   aufbewahrt werden. Keine Änderung am Purge-Verhalten nötig — das
   Modul löscht Dokumente ohnehin nie automatisch.

### 8.1 Konsequenzen aus der N:M-Entscheidung

- `documents` trägt nur die **dokument-weiten** Felder:
  `tax_relevant` (bool), `tax_year` (int), `tax_year_confidence` (real),
  `tax_reviewed` (bool). Keine `tax_section`-Spalte auf `documents`
  mehr — sie wandert in die Join-Tabelle.
- `document_tax_sections` (neu) speichert pro (document_id, tax_section)
  die KI-`confidence` und eine `source`-Enum `{ai, user}`. Damit kann
  der Klassifizierer gefahrlos neu laufen: er löscht nur seine eigenen
  `source='ai'`-Zeilen und ersetzt sie, User-Zuweisungen
  (`source='user'`) bleiben unangetastet.
- Der LLM-Prompt liefert `tax_sections: Array<{slug, confidence}>`
  statt eines einzelnen Slug.
