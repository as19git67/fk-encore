# Tax Document Detection — Feature Plan

Goal: When a document is classified automatically, the AI should additionally
detect (a) **whether** the document is relevant for the German income tax
return, (b) for **which tax year** and (c) which **Anlage (form appendix) /
deduction area** it belongs to. The frontend gets a "Steuer" (tax) view that
shows all documents marked as tax-relevant, grouped by tax year and Anlage
("one click → all receipts for 2025 sorted by Anlage").

Status: Feature plan, implementation in stages.

---

## 1. Research: German income tax — Anlagen & deduction areas

The income tax return consists of the **main form (Mantelbogen)** for personal
data and thematic **Anlagen**. Each receipt belongs to exactly one main Anlage
(income-related expenses (Werbungskosten) can however occur within Anlage N, V,
KAP, R — hence an additional subtype).

### 1.1 Income Anlagen (income)

| Slug            | Anlage / form             | Typical receipts                                                                |
|-----------------|---------------------------|---------------------------------------------------------------------------------|
| `anlage-n`      | Anlage N                  | Wage tax certificate (Lohnsteuerbescheinigung), employer certificate, payslips  |
| `anlage-kap`    | Anlage KAP                | Annual tax certificate from the bank/broker, dividends, interest statements     |
| `anlage-v`      | Anlage V (rental)         | Proof of rental income, utility cost statements (landlord), HOA statements      |
| `anlage-r`      | Anlage R (pensions)       | Pension benefit notification from Deutsche Rentenversicherung, private pension payouts |
| `anlage-r-aus`  | Anlage R-AUS              | Foreign pensions                                                                |
| `anlage-r-av`   | Anlage R-AV/bAV           | Benefits from company pension scheme (bAV) / Riester payouts                    |
| `anlage-g`      | Anlage G (trade)          | Trade income, balance sheets                                                    |
| `anlage-s`      | Anlage S (self-employed)  | Income from freelance/self-employed work                                        |
| `anlage-euer`   | Anlage EÜR                | Cash-basis profit statement (belongs to G or S)                                 |
| `anlage-so`     | Anlage SO                 | Other income (private sales, receipt of maintenance)                            |

### 1.2 Deduction Anlagen (expenses → reduce tax)

| Slug                    | Anlage / category                 | Typical receipts                                                                 |
|-------------------------|-----------------------------------|----------------------------------------------------------------------------------|
| `werbungskosten-n`      | Income-related expenses (Anlage N) | Commuting proofs, continuing education, work equipment, home office, travel expenses |
| `werbungskosten-v`      | Income-related expenses (Anlage V) | Repairs of rental property, property tax on rental property, HOA fees (Hausgeld), loan interest |
| `werbungskosten-kap`    | Income-related expenses (Anlage KAP) | (rare, special cases only)                                                      |
| `werbungskosten-r`      | Income-related expenses (Anlage R) | Tax advisor costs of pensioners, pension advisory costs                          |
| `sonderausgaben`        | Special expenses (Sonderausgaben)  | Donation receipts, church tax, maintenance payments (§10), tax advisory          |
| `vorsorgeaufwand`       | Anlage Vorsorgeaufwand (provision expenses) | Health insurance contributions, long-term care insurance, Rürup, liability insurance, accident insurance |
| `anlage-av`             | Anlage AV (Riester)               | Riester contract certificate, subsidy application                                |
| `aussergewoehnliche`    | Extraordinary burdens (außergewöhnliche Belastungen) | Medical costs, dentist, medication (prescription), nursing home, spa treatment, funeral |
| `haushaltsnahe`         | Household-related services/craftsmen (§35a) | Invoices for cleaner, garden work, craftsmen (labor share) + bank statement proof |
| `anlage-kind`           | Anlage Kind (child)               | Birth certificate, child benefit proof, school certificate, childcare costs      |
| `anlage-unterhalt`      | Anlage Unterhalt (maintenance)    | Maintenance payments to persons in need                                          |
| `anlage-energetisch`    | Anlage energy-efficiency measures (§35c) | Invoices & certificate for energy-efficient renovation of an owner-occupied property |

### 1.3 Assessment notice / framework

| Slug                    | Category                          | Typical receipts                                       |
|-------------------------|-----------------------------------|--------------------------------------------------------|
| `steuerbescheid`        | Tax office notice (not a receipt) | Income tax assessment notice, prepayment notice        |
| `mantelbogen`           | Master data / personal            | Marriage certificate, proof of address (usually not needed) |

The list is deliberately closely modeled on the real ELSTER/tax-office Anlagen,
because the output of the feature is meant to be a **printable filing list per
Anlage** (the user can go into the tax return with the stack of paper).

---

## 2. Domain constants (`documents/tax-sections.ts`, new)

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

The enum is deliberately a TS constant (not a DB table): small,
version-controlled, easily extensible; the AI gets the list per `/classify`
call as part of the prompt, just like the category taxonomy today.

---

## 3. DB migration `0029_tax_fields.sql`

Adds three columns to the `documents` table and an index for the grouping
query. No new table needed.

```sql
ALTER TABLE documents
  ADD COLUMN tax_relevant          boolean NOT NULL DEFAULT false,
  ADD COLUMN tax_year              integer,
  ADD COLUMN tax_section           text,
  ADD COLUMN tax_confidence        real,
  ADD COLUMN tax_user_confirmed    boolean NOT NULL DEFAULT false;

-- Value range check (defensive; protects against AI slips)
ALTER TABLE documents
  ADD CONSTRAINT documents_tax_year_range
    CHECK (tax_year IS NULL OR (tax_year BETWEEN 2000 AND 2100));

CREATE INDEX documents_tax_idx
  ON documents (tax_relevant, tax_year, tax_section)
  WHERE tax_relevant = true;
```

Corresponding change in `db/schema.ts` (Drizzle):

```ts
tax_relevant:       boolean("tax_relevant").notNull().default(false),
tax_year:           integer("tax_year"),
tax_section:        text("tax_section"),          // TaxSectionSlug or null
tax_confidence:     real("tax_confidence"),
tax_user_confirmed: boolean("tax_user_confirmed").notNull().default(false),
```

`tax_user_confirmed` distinguishes user-confirmed values from AI suggestions
(like `classification_confidence` → the UI shows "KI-Vorschlag" (AI suggestion)
with a confirm button).

---

## 4. LLM service (`llm-service/main.py`)

Two small adjustments, no new endpoint needed.

**4.1 Extend the response schema** (`ClassifyResponse`):

```py
class ClassifyResponse(BaseModel):
    category_slug: str
    title: str
    doc_date: str | None = None
    sender: str | None = None
    summary: str
    tags: list[str]
    confidence: float = Field(..., ge=0.0, le=1.0)
    # New:
    tax_relevant: bool = False
    tax_year: int | None = None
    tax_section: str | None = None     # slug from TAX_SECTIONS
    tax_confidence: float = Field(0.0, ge=0.0, le=1.0)
```

**4.2 Extend the request by `tax_sections`** (Encore ts passes the list), and
append to the system prompt (the prompt text is sent to the model in German and
is therefore kept verbatim):

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
    * Bei einem Kirchensteuerbescheid NICHT das in der Überschrift genannte
      Veranlagungsjahr, sondern das Jahr der Nachzahlung bzw. Erstattung/
      Gutschrift (§ 11 EStG, Zu-/Abflussprinzip) — in der Regel das Jahr des
      Bescheiddatums bzw. einer ausgewiesenen Fälligkeit. Beispiel:
      "Kirchensteuerbescheid 2019" vom 19.04.2021 mit Guthaben → 2021. Auch
      hier greift zusätzlich eine deterministische Nachprüfung
      (`applyKirchensteuerBescheidYearTaxRule` in `documents/tax-rules.ts`);
      reine Vorauszahlungsbescheide bleiben unangetastet.
    * Bei Unsicherheit: null.
- tax_section: der passendste Slug aus der gegebenen Steuerabschnitts-Liste
  oder null, wenn tax_relevant=false oder die Zuordnung unsicher ist.
- tax_confidence: 0..1, dein Vertrauen in die Steuer-Zuordnung
  (unabhängig von confidence der Hauptkategorie).
```

The prompt then lists all `TAX_SECTIONS` (slug + name) by group, just like the
category taxonomy today.

**4.3 Tokens**: raise `max_tokens` from 512 → 640 (four new fields).
The context (6000 characters of text + taxonomy + tax list) stays within bounds.

**4.4 Tests** (`llm-service/tests/`): new fixture test that uses a mock LLM to
check that `ClassifyResponse` passes tax fields through and default values are
correct.

---

## 5. Encore service (`documents/`)

**5.1 `llm-client.ts`** — extend types with tax fields:

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

`parseClassification()` validates the new fields (tax_year only if an integer
2000..2100, tax_section only if in `TAX_SECTIONS`, otherwise null).

**5.2 `document-ops.ts:runClassify`** — additionally persists:

```ts
tax_relevant:   classification.tax_relevant,
tax_year:       classification.tax_year,
tax_section:    classification.tax_section,
tax_confidence: classification.tax_confidence,
// tax_user_confirmed stays false
```

**5.3 New endpoints in `documents.ts`**:

- `GET /documents/tax/years` → `{ years: number[] }` — DISTINCT `tax_year`
  across all tax-relevant documents of the user (for dropdown).
- `GET /documents/tax?year=2025` → grouped list:
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
  Sorted: first `einkuenfte`, then `abzuege`, then `bescheid`.
- `POST /documents/:id/tax` — manual override by the user:
  ```ts
  { tax_relevant?: boolean; tax_year?: number | null; tax_section?: TaxSectionSlug | null }
  ```
  sets `tax_user_confirmed = true`.
- Extend `listDocuments` by filters: `tax_relevant?: boolean`,
  `tax_year?: number`, `tax_section?: TaxSectionSlug`.

**5.4 Backfill script** (`documents/backfill-tax.ts`, one-shot):
Re-enqueues all existing `ready` documents into a `classify` job, so that the
AI also enriches the legacy inventory with tax fields. Alternatively: a
tax-only job (`runClassifyTaxOnly`) that sends the `extracted_text` through the
LLM again but only updates the tax fields (saves tokens).

---

## 6. Frontend (`frontend/src/views/`)

**6.1 New route `/documents/steuer`** → `TaxView.vue`:

- At the top: dropdown **Steuerjahr** (tax year; default: current year − 1),
  toggle "auch unbestätigte KI-Vorschläge anzeigen" (also show unconfirmed AI
  suggestions), button "Checkliste als PDF/Druck" (checklist as PDF/print).
- Below: one section per `group` ("Einkünfte", "Abzüge", "Bescheide"), one
  collapsible panel per `tax_section` with a doc list (file name, sender, date,
  amount if available, confidence badge if AI suggestion).
- Unassigned bucket at the end ("Steuerrelevant, aber Anlage unklar — bitte
  prüfen": tax-relevant, but Anlage unclear — please check).

**6.2 `DocumentDetailView.vue`** — new card "Steuer":

- Toggle `Steuerrelevant`
- Number field `Steuerjahr`
- Select `Anlage / Abzugsbereich` (grouped by group)
- AI badge "Vorschlag (72%)" (suggestion) as long as
  `tax_user_confirmed=false`; button "Übernehmen" (accept) sets
  `tax_user_confirmed=true`.

**6.3 `DocumentsView.vue`** — new filter chips: `Steuer 2024`, `Steuer 2025`
(only visible if years exist). Click sets `tax_relevant=true` +
`tax_year=X`.

**6.4 Navigation** — the menu item "Dokumente" gets the sub-entry "Steuer".

---

## 7. Stages (how I'll have it committed)

1. **Schema & enum** — migration 0029, `schema.ts`, `tax-sections.ts`,
   Drizzle types. Green via `drizzle-kit check` and existing tests.
2. **LLM prompt & client types** — extend `llm-service/main.py`,
   `llm-client.ts` type + parser, Python test + TS unit test for the parser.
3. **Persistence & backfill** — `runClassify` writes tax fields;
   backfill script; manual override endpoints.
4. **Listing/grouping API** — `/documents/tax` + `/tax/years` +
   filter query params; Encore tests.
5. **Frontend tax view** — new route, detail card, filter chips,
   print layout.
6. **QA pass** — real sample receipts (wage tax certificate,
   craftsman invoice, donation receipt, doctor's invoice, annual tax
   certificate) through the pipeline; manual review of the AI assignment,
   threshold `tax_confidence < 0.7` → UI hint "bitte bestätigen" (please
   confirm).

---

## 8. Decided questions

1. **Multiple sections per document**: **N:M** via join table
   `document_tax_sections`. Reasoning: real receipts often fit into several
   Anlagen (craftsman at a rental property = Anlage V + possibly §35a, payslip
   = Anlage N + §35a for pension benefits, …).
2. **Amount extraction**: Only in **iteration 2**. Iteration 1 delivers only
   classification; the printout states "Betrag lt. Beleg" (amount per receipt) —
   the user enters it into ELSTER themselves.
3. **`werbungskosten-*` fine-grained**: One slug per Anlage (N/V/KAP/R).
   AI fallback: if unsure → `werbungskosten-n` (most common case) with low
   confidence.
4. **Data protection / retention**: Tax receipts must be retained in DE for
   ≥ 2 years (private, income tax) up to 10 years (landlord/self-employed). No
   change to the purge behavior needed — the module never deletes documents
   automatically anyway.

### 8.1 Consequences of the N:M decision

- `documents` carries only the **document-wide** fields:
  `tax_relevant` (bool), `tax_year` (int), `tax_year_confidence` (real),
  `tax_reviewed` (bool). No `tax_section` column on `documents` any
  more — it moves into the join table.
- `document_tax_sections` (new) stores per (document_id, tax_section)
  the AI `confidence` and a `source` enum `{ai, user}`. This allows the
  classifier to safely run again: it only deletes its own
  `source='ai'` rows and replaces them, user assignments
  (`source='user'`) remain untouched.
- The LLM prompt delivers `tax_sections: Array<{slug, confidence}>`
  instead of a single slug.

---

## 9. Subject-person tax review (migrations 0137–0146)

Supplements the document-wide tax detection (§ 1–8) with a
**person-related** tax review logic: If a document is assigned to a
subject person (via name matching in the classifier), the system automatically
determines whether the document should be flagged for manual tax review —
depending on relationship type, age, assessment and the person's own tax return
status.

### 9.1 Data model

**`user_subject_persons`** (extended in 0137/0145/0146):

| Column | Type | Description |
|--------|-----|--------------|
| `relation_kind` | enum | `self`, `spouse`, `child`, `parent`, `sibling`, `ward`, `other` |
| `birth_date` | date | Date of birth (optional, relevant for the age limit) |
| `in_household` | boolean | Lives in the same household |
| `tax_cost_bearer` | enum | `unknown`, `user`, `person` — who bears the costs |
| `requires_tax_review` | boolean | Effective flag (stored value) |
| `requires_tax_review_override` | boolean/null | Manual override; `null` = derive automatically |
| `own_tax_return_from_tax_year` | integer/null | From which tax year the person files their own tax return |

**`documents`** (extended in 0146):

| Column | Type | Description |
|--------|-----|--------------|
| `tax_return_person_id` | FK → `user_subject_persons(id)` | Person to whose own tax file the document belongs (ON DELETE SET NULL) |

### 9.2 Derivation logic (`documents/subject-persons.ts`)

The tax review is derived **per document and its tax year** (not across the
board for the person):

```
deriveRequiresTaxReview(person, referenceYear):
  1. person has own tax return from ≤ referenceYear → false
  2. person.relation_kind = 'self' → false
  3. person.relation_kind = 'spouse' AND joint assessment → false
  4. person.relation_kind = 'child' AND in household
     AND age ≤ 25 in referenceYear → false  (§ 32 para. 4 EStG)
  5. otherwise → true (must be reviewed manually)
```

**Priority rule** (`computeEffectiveRequiresTaxReview`):
- Own tax return (`own_tax_return_from_tax_year`) beats everything →
  `false` (the document belongs in the own file, not in the review list).
- Manual override (`requires_tax_review_override`) beats the derivation.
- Without an override → automatic derivation via `deriveRequiresTaxReview`.

### 9.3 § 32 para. 4 EStG — age limit 25

Children can be considered for tax purposes as dependents (child allowance,
Anlage Kind) as long as they have not yet completed their 25th year of life.
The check works at year granularity: A child who turns 25 in tax year 2025
still counts as within the limit in 2025
(`referenceYear − birthYear ≤ 25`), but no longer from 2026.

### 9.4 Own tax file (`tax_return_person_id`)

If a person has entered a tax year under „Eigene Erklärung ab" (own return
from), and a document is assigned to this or a later year, the document is
moved into the person's **own tax file**:

- **On classification** (`document-ops.ts:runClassify`): The
  classifier checks whether exactly one of the matched persons files
  their own tax return for the document's tax year. If so,
  it sets `tax_return_person_id`. In case of ambiguity (several
  candidates) the field stays empty.
- **Retroactively** (`syncOwnTaxReturnAssignment`): If a person's
  `own_tax_return_from_tax_year` is changed, all
  affected documents are assigned or detached retroactively.

### 9.5 Frontend view

**SubjectPersonsView** (`frontend/src/views/SubjectPersonsView.vue`):
- Column „Eigene Erklärung ab" with year input.
- Column „Steuer-Prüfung" (tax review) shows the effective status with tags:
  - `auto` — derived automatically.
  - `manuell` — explicitly switched on/off (click resets to auto).
  - `eigene Akte` — person has their own tax return.
- A collapsible column legend explains each column.

**DocumentsSteuerView** (`frontend/src/views/DocumentsSteuerView.vue`):
- Tax file switcher: buttons filter the view by person
  (`?tax_return_person=<id>`).
- The default view excludes documents that are assigned to an own file.

### 9.6 Daily cron (`tax-review-recompute-cron.ts`)

Daily at 11:00 UTC (13:00 summer time, 12:00 winter time) a cron job runs that
recomputes the tax review flags for all users. Purpose: When a child exceeds
the age limit on 1 January of a new year, the review status changes for future
tax years — without the user having to edit anything.

Per user, the cron calls `recomputeDerivedTaxReviewForUser` and
`syncTaxReviewFlagForAllSubjectPersons`. Each document is evaluated
individually against its own tax year.

### 9.7 Sync logic (`documents/documents.ts`)

`syncTaxReviewFlagForSubjectPerson` evaluates **per document** instead of
across the board via an SQL UPDATE:
1. Loads all derivation fields of the person.
2. Loads all documents linked to the person.
3. Determines the `referenceYear` for each document (= `doc.tax_year`
   or the current year as a fallback).
4. Caches `getEffectiveAssessmentType(userId, year)` per year.
5. Writes `tax_review_needed` individually per document.

### 9.8 Migrations (overview)

| Migration | Content |
|-----------|--------|
| 0137 | `user_subject_persons`: `relation_kind`, `birth_date`, `in_household`, `tax_cost_bearer`, `requires_tax_review` → tax review system |
| 0138 | Assessment settings table (`user_assessment_settings`) |
| 0145 | `requires_tax_review_override` — separates manual override from the effective value |
| 0146 | `own_tax_return_from_tax_year` on `user_subject_persons`, `tax_return_person_id` FK on `documents` |
