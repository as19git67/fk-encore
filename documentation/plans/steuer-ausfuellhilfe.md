# Tax worksheet by form field: read every value from the evidence

## Problem

The Ausfüllhilfe (`assistant/tax-worksheet.ts`, dialog on the Steuer page,
assistant tools `tax_worksheet` / `tax_worksheet_pdf`) shows one amount per
document. That amount comes from `extractReceiptAmount` in
`documents/documents.ts`, a rule written for till receipts: the first number
after "Betrag", "Summe" or "Gesamt", otherwise the last money value in the
text. A Lohnsteuerbescheinigung carries some twenty numbered values, a
bank's Jahressteuerbescheinigung a dozen; the rule hits whichever comes
first or last. The amounts look invented because they are.

Beyond that, the worksheet has no notion of the form itself. A tax return is
filled in Anlage by Anlage, line by line, each value under a Kennzahl. One
Kennzahl often takes values from several pieces of evidence (two employers,
three banks), and some values only count after the law is applied (only the
labour share of a craftsman's invoice, 20 % of it, at most 1.200 €).

## Goal

1. Every piece of tax evidence is read for the values the form asks for,
   once, when the classifier settles that it is evidence for an Anlage.
2. The values are mapped to the Kennzahlen of the year's forms, per person
   (joint assessment: the taxpayer and the spouse each have their own
   Anlage N, KAP, …), summed where several documents feed one Kennzahl, and
   the law is applied where a value is not entered as read.
3. The worksheet lists Anlage → line → Kennzahl → value, each value
   traceable to the documents and the text it came from, confirmable and
   correctable by the user.
4. The PDF is that list, ordered by Kennzahl for typing into ELSTER, with an
   appendix per summed Kennzahl naming every document and amount. No filled
   official forms: with Gewinneinkünfte (Anlage L) the return is filed
   electronically anyway (§ 25 Abs. 4 EStG).

Non-goals: computing the tax; replacing ELSTER's prefilled data
(Belegabruf). Values the Finanzamt already receives electronically
(Lohnsteuerbescheinigung, Rentenbezugsmitteilung, Basis-KV/PV contributions)
are marked "vom Finanzamt vorausgefüllt, nur prüfen" rather than left out —
the household checks them against its own copy.

## Design

### Form catalogue (data)

`documents/tax-forms/<year>.ts` holds the year's form fields:

```ts
interface FormField {
  key: string;             // stable across years: "n.bruttoarbeitslohn"
  anlage: TaxSectionSlug;  // the section the Steuer page already knows
  line: number;            // Zeile on the year's Vordruck
  kennzahl: string | null; // null while not verified against the Vordruck
  label: string;           // as printed on the form
  kind: "amount" | "count" | "days" | "flag";
  perPerson: boolean;      // N, KAP, R … per spouse; V, Kind … per return
  prefilled: boolean;      // the Finanzamt receives it electronically
  source: string;          // which Vordruck and edition the line was taken from
}
```

Kennzahlen and line numbers change every year, so a year's catalogue is a
file of its own, and every entry names the edition of the form it was
copied from. An entry not checked against the official form keeps
`kennzahl: null`; the worksheet then prints the label and "Kennzahl prüfen"
instead of guessing. The `key` stays the same across years so values and
corrections carry over.

### Evidence kinds and their fields (data)

`documents/tax-evidence-kinds.ts` lists the kinds of evidence and the values
printed on each, in the words the document uses:

| Kind | Anlagen | Values (examples) |
|---|---|---|
| Lohnsteuerbescheinigung | N, Vorsorgeaufwand | Nr. 3 Bruttoarbeitslohn, 4 Lohnsteuer, 5 Soli, 6/7 Kirchensteuer, 22a/b, 23a/b, 25–28 social insurance |
| Jahressteuerbescheinigung der Bank | KAP | Kapitalerträge, darin Gewinne aus Aktienveräußerungen, Verluste (Aktien, sonstige), genutzter Sparer-Pauschbetrag, KapESt, Soli, KiSt, angerechnete ausländische Steuer |
| Beitragsbescheinigung KV/PV | Vorsorgeaufwand | Basis-KV, PV, Wahlleistungen, Erstattungen |
| Rentenbezugsmitteilung / Rentenanpassung | R | Jahresbetrag der Rente, Rentenbeginn |
| Handwerkerrechnung | haushaltsnahe | Arbeitskosten, Material, Rechnungsbetrag, Zahlungsart |
| Nebenkostenabrechnung | haushaltsnahe | §35a-Anteile je Position (Dienstleistungen, Handwerker) |
| Zuwendungsbestätigung | sonderausgaben | Betrag, Art (Geld/Sach), Empfänger |
| Riester-/Rürup-Bescheinigung | AV, vorsorgeaufwand | Beiträge, Zulagenummer vorhanden |
| Krankheitskosten, Pflege | aussergewoehnliche | Betrag, Erstattung durch Kasse |
| Kita-/Betreuungsrechnung | anlage-kind | Betreuungskosten, ohne Verpflegung |

Each value has a key, its label on the document, a type and plausibility
rules (Lohnsteuer < Bruttoarbeitslohn, Soli ≤ 5,5 % of the Lohnsteuer, …).
A kind not in the list is read with a generic schema ("which amounts on
this document belong into Anlage X?") and its values stay unconfirmed until
the user maps them.

### Reading the evidence (queue service `tax_values`)

After `runClassify` settles `tax_role = beleg` with sections and a tax
year, the document is queued for `tax_values`. The worker:

1. picks the candidate evidence kinds for the sections and the
   `document_type`, and asks the model which one it is (one small call);
2. asks for exactly that kind's values with the field list as a JSON
   schema, each answer with the number as printed and a short quote;
3. checks every value: the printed number must occur in the text (the
   anchoring the depot statements use, `finance/depot-statement-enrichment.ts`),
   German number format parsed by one helper, plausibility rules of the
   kind; a value that fails is stored with status `rejected` and the reason,
   never silently dropped;
4. assigns the person: the name on the evidence matched against the
   household (`subject_persons.relation_kind` = `self` / `spouse`); joint
   items (Nebenkosten, Spenden of the household) get `joint`;
5. stores the values in `document_tax_value`.

```
document_tax_value(
  id, document_id, tax_year, person ('self' | 'spouse' | 'joint' | subject_person_id),
  evidence_kind, field_key, amount_cents, count_value, quote, page,
  confidence, status ('read' | 'rejected' | 'confirmed' | 'corrected'),
  corrected_by, created_at, updated_at,
  UNIQUE (document_id, field_key, person)
)
```

Re-reading a document replaces `read`/`rejected` rows and leaves
`confirmed`/`corrected` ones alone. A backfill endpoint queues every
evidence document of a year, as `page_words` does.

### From evidence values to form values (code, with the law)

`documents/tax-form-mapping.ts` maps evidence values to form fields per year
and person. Most mappings are one-to-one sums (Bruttoarbeitslohn of all
employers). Where the law decides, it is code with a test per rule:

- § 35a EStG: haushaltsnahe Dienstleistungen and Handwerkerleistungen are
  entered as the eligible expense; the worksheet also shows the reduction
  (20 %, caps 4.000 € and 1.200 €) for information. Only labour, travel and
  machine costs count, never material; only non-cash payment counts.
- Sparer-Pauschbetrag 1.000 € per person, 2.000 € jointly; the worksheet
  shows how much the banks already used.
- Arbeitnehmer-Pauschbetrag 1.230 € per person: Werbungskosten below it are
  shown with the note that the Pauschbetrag applies.
- Vorsorgeaufwand: Basis-KV/PV separate from Wahlleistungen; refunds reduce.
- Außergewöhnliche Belastungen: entered gross; the zumutbare Belastung is
  computed only when the Gesamtbetrag der Einkünfte is known, otherwise the
  worksheet says so.
- Bezug documents (Erträgnisaufstellung) never feed a Kennzahl.

Every rule cites its paragraph in a comment and in the worksheet's note.

### The worksheet and its PDF

`buildTaxWorksheet` returns, per Anlage and person, the form fields with
their value, the contributing evidence values (document, amount, quote,
status) and notes. The Steuer page dialog shows that tree; each value can
be confirmed or corrected, and a correction is stored on the evidence value
(and later taught to the extraction like `learned-rules.ts` teaches roles).
The PDF lists, per Anlage and person, Zeile · Kennzahl · Bezeichnung · Wert,
with "siehe Anlage n" where a value is a sum, and an appendix per summed
Kennzahl naming each document and amount.

## Stages

0. **Stop the invented amounts.** The worksheet no longer calls the receipt
   rule; documents are listed per Anlage without amounts, with a note that
   the values are read per Kennzahl in a later stage. Dialog, PDF, tool text
   and tests follow.
1. **Catalogue, evidence kinds, mapping.** `tax-forms/2025.ts` for N, KAP,
   Vorsorgeaufwand, Sonderausgaben, haushaltsnahe, außergewöhnliche
   Belastungen, V, Kind, AV, R; the evidence kinds of the table above; the
   mapping with the rules. Pure code with tests, synthetic values only.
2. **Reading.** Queue service `tax_values`, prompts and schemas in the
   llm-service client, anchoring and plausibility checks, table and
   migration, backfill endpoint, person assignment.
3. **Worksheet by Kennzahl.** New `buildTaxWorksheet`, dialog tree with
   confirm/correct, assistant tools reading the new structure.
4. **PDF by Kennzahl** for ELSTER, with the appendix.
5. **Learning and comparison.** Corrections feed the extraction prompt as
   examples per sender and kind; last year's values beside this year's.

## Status

- Stage 0: done. The worksheet no longer calls the receipt rule; dialog,
  PDF, tool text and the assistant's rule say that the documents' values
  are not read yet. The dialog formatted the worksheet's EUR amounts
  (bookings, businesses) as cents; fixed with it.
- Stage 1: done, without Kennzahlen. `documents/tax-forms/catalogue.ts`
  with the 2025 fields in `tax-forms/2025.ts` (N, Werbungskosten N,
  Vorsorgeaufwand, KAP, R, AV, Sonderausgaben, § 35a, außergewöhnliche
  Belastungen, Kind, V); every `line` and `kennzahl` is `null` because the
  official Vordrucke could not be reached from the build environment. A year
  without its own catalogue uses the newest older one with lines and
  Kennzahlen cleared. `documents/tax-evidence-kinds.ts` lists 15 evidence
  kinds with their fields, the form field each feeds and plausibility
  checks; `evidenceKindsFor` offers the kinds that fit a document's sections
  and type. `documents/tax-amounts.ts` parses German amounts to cents and
  checks that a number stands in the text on its own (not inside a longer
  one). `documents/tax-form-mapping.ts` sums per field and owner, splits a
  shared certificate half and half under joint assessment, redirects party
  donations (§ 34g), drops cash-paid § 35a costs (§ 35a Abs. 5), and adds
  the law as notes: § 35a reductions and caps, Sparer-Pauschbetrag, the
  Arbeitnehmer-Pauschbetrag, childcare (80 %/4.800 € from 2025, two thirds/
  4.000 € before), Schulgeld, Spenden, zumutbare Belastung, prefilled data.
- Kennzahlen 2025: done. `line`, `kennzahl` and `source` in
  `tax-forms/2025.ts` are read off the official 2025 Vordrucke of the
  Formular-Management-System (formulare-bfinv.de, edition 2025/4.1.1.0),
  each field's Kennzahl being the number printed beside its input box.
  Two fields were added to `FormField`: `kennzahlSpouse` for Vordrucke that
  hold both spouses side by side (Anlage Vorsorgeaufwand: Person A in the
  300s, Person B in the 400s) and `formNote` for what the form says beyond
  line and Kennzahl. Left open on purpose, with a note: Anlage V prints no
  Kennzahlen in 2025 (lines only; Grundsteuer and Versicherungen depend on
  whether they are passed on to the tenant); Wahlleistungen and
  Beitragserstattungen sit in different lines for statutory and private
  insurance; Anlage AV has no field for the contributions, the provider
  transmits them. The Anlage Sonderausgaben is filled in jointly, so the
  Kirchensteuer fields are one value per return. Tests pin a sample of the
  Kennzahlen and refuse two fields sharing one on the same Vordruck.
- Stage 2: done. Queue service `tax_values` (`documents/tax-values.ts`),
  queued after classify and after a manual tax edit whenever the document
  is `beleg` with a tax year and a candidate kind, and waiting for classify
  to finish. One question picks the kind when more than one fits; a second
  reads that kind's fields with the number as printed and its line. Every
  amount must stand in the text (`amountAnchored`), a flag needs a quote the
  text contains; anything else is stored as `rejected` with its reason. The
  kind's plausibility rules attach "Prüfen: …" to values that cannot both
  be right. The owner comes from the Bezugspersonen on the document (self,
  spouse, both = joint, exactly one child), never from the model; the page
  from the word positions. Table `document_tax_value` (migration 0262),
  `document_tax_reading` records the kind each document was read as. A
  re-read replaces `read`/`rejected` rows and keeps `confirmed`/`corrected`;
  a document that is no evidence any more loses its read values. Admin
  backfill `POST /documents/tax-values/backfill` (`year`, `reread`, `limit`)
  in `documents/tax-values-api.ts`.
- Stage 3: done. `GET /documents/tax/form-values` (`documents/tax-form-values.ts`)
  runs the stored values of the documents the caller may see through
  `mapToForm` and returns per Anlage and owner the field with line,
  Kennzahl (Person B's where the form has one), the place as text ("Zeile 5
  · Kz 110", "Kennzahl prüfen" while unchecked), the sum and every
  contribution with document, quote, page and status; rejected values come
  as `skipped` so they can be corrected. Joint assessment is assumed while
  the household has a spouse without a return of their own for the year.
  `POST /documents/tax/values/:id/confirm` and `/correct` (`documents.edit`)
  set `confirmed` / `corrected` with `corrected_by`; both survive a re-read.
  `buildTaxWorksheet` carries the result as `form` and says in its hints
  what is left: evidence not read yet, values not confirmed, rejected
  values, unchecked Kennzahlen. The Steuer page dialog shows Anlage →
  person → Zeile · Kz → value with its documents and confirms or corrects
  each contribution in place; the assistant's `tax_worksheet` lists the
  same tree and may state a document's figure only as listed there.
- Stage 4: done. The PDF (`assistant/tax-worksheet-pdf.ts`) opens with the
  values by Anlage and person, Zeile · Kennzahl · Bezeichnung · Wert in the
  order of the form (line, then Kennzahl), each row naming its one document
  or "siehe Anhang n" when it is a sum, and marking what is left to do
  (Kennzahl unchecked, value unconfirmed, prefilled data). Values not taken
  follow; the documents, bookings, businesses, depot and hints come after.
  An appendix lists every summed value with each document, the value on
  it, its share and status, and the total. `kennzahlSheet` builds the rows
  and is tested on its own. The stored PDF is linked to the flagged
  documents and to those behind a value.
- Stage 5: open.
