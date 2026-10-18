# Tax relevance as a role: evidence, context, none

## Problem

`documents.tax_relevant` answers two questions with one boolean:

1. *Which tax matter does this document concern?* (the section: Anlage KAP,
   Anlage Kind, haushaltsnahe …)
2. *Is this document the evidence that is filed with or kept for the
   return?*

The local classifier answers the first question well and the second one
badly. A 4B model does not reliably separate "is about capital income"
from "is the Jahressteuerbescheinigung". Because the output is a boolean it
has no way to say "about it, but not the evidence", and it leans towards
`true` whenever the topic is clearly a tax topic.

Every false positive has so far been fixed by one more paragraph in
`CLASSIFY_TAX_PROMPT` and one more deterministic function in
`documents/tax-rules.ts` (insurance admin mail, Kindergeld notices, single
securities settlements, Kirchensteuer years). Three of the user's current
examples show that this is not a model problem at all: the
Schulbescheinigung is listed as evidence in the Anlage Kind hint, and the
Erträgnisaufstellung is declared evidence in the KAP hint, in prompt rule 1
and in the securities rule's marker list. The code says what the model is
then blamed for.

What the code does today (October 2026):

- `tax_relevant` is written by `runClassify` (`documents/document-ops.ts`)
  from the LLM answer after the rules in `tax-rules.ts` ran; a human pins
  it through `POST /documents/:id/tax` (`tax_reviewed = true`).
- `parseTaxFields` in `llm-client.ts` forces `tax_relevant = false` when no
  section survived validation, and the tax endpoint wipes year and sections
  when the user sets `tax_relevant = false`. A document is therefore either
  "evidence with sections" or "nothing"; the middle does not exist.
- The learning loop in `learned-rules.ts` learns only positive signals from
  reviewed documents (sender → sections). A document the user set to "not
  relevant" twice does not change the third one.
- The Steuer page (`GET /documents/tax`), the `_steuer/` hardlink view
  (`relocate.ts`), the retention class and the Ausfüllhilfe all read
  `tax_relevant`.

## Decisions

- **Three roles instead of a boolean.** A document has a `tax_role`:
  - `beleg` — the evidence. It is filed with, or kept for, the income-tax
    return. This is what `tax_relevant = true` means today.
  - `bezug` — concerns a tax matter but is not the evidence: the monthly
    payslip, the dividend credit, the Erträgnisaufstellung, the
    insurance Standmitteilung, the school report. It keeps its sections so
    it is found next to the evidence, but it never counts as a tax
    document.
  - `keine` — no tax relation at all. No sections.

  `tax_relevant` stays as a column and in every DTO; it is derived
  (`tax_role = 'beleg'`) so the Steuer page, the hardlink view, retention
  and the Ausfüllhilfe keep working unchanged. Invariants: `beleg` has at
  least one section and a tax year; `bezug` has at least one section;
  `keine` has none.
- **The model names the role, a matrix decides whether it may be
  evidence.** The classifier emits `tax_role` instead of `tax_relevant`,
  which gives it the way out it does not have today. Whether a `beleg`
  stands is then decided deterministically from the document type
  (`document_type`, the Dokumentart facet) and the section, by an
  *evidence matrix* in `documents/tax-sections.ts`: per section, which
  document types can be evidence. Anlage KAP accepts only
  `bescheinigung`; haushaltsnahe accepts `rechnung`, `abrechnung` and
  `beleg`; Anlage Kind accepts `bescheid` and `rechnung`, and
  `bescheinigung` only for a child of 18 or older in the tax year. The
  matrix can only *downgrade* (`beleg` → `bezug`), never upgrade, and it
  does nothing when the document type is unknown, so a wrong type can cost
  a document its evidence status but never invent one. A new case is a row
  in the matrix, not a new function.
- **The Erträgnisaufstellung is never evidence.** The
  Jahressteuerbescheinigung is the bank's tax certificate; the
  Erträgnisaufstellung is an information sheet. It becomes `bezug` with
  Anlage KAP. The securities rule, the KAP hint and prompt rule 1 are
  changed accordingly.
- **The text rules stay, but they speak in roles.** The high-precision
  marker rules in `tax-rules.ts` remain the only way to *force* `beleg`
  (a Jahressteuerbescheinigung whose document type the model got wrong, a
  Kindergeld notice). Their "not relevant" outcomes become `bezug` with the
  sections kept, not an empty list, so the insurance Standmitteilung still
  appears under Vorsorge.
- **The user's "no" is learned.** `learned-rules.ts` learns, per sender
  *and document type*, the role the user pins. Two reviewed documents of
  the same sender and type that are `bezug` or `keine`, with none `beleg`,
  downgrade the next one. The key must include the document type because
  the same bank sends the Jahressteuerbescheinigung and the
  Erträgnisaufstellung. This runs last, after the matrix and the text
  rules: the user's decision wins over everything.
- **Household facts are applied deterministically.** The age limit of
  § 32 Abs. 4 EStG that the review derivation already knows
  (`subject-persons.ts`) feeds the matrix condition for Anlage Kind. The
  classifier is not asked to know a child's age.
- **Both roles are visible.** The detail page, the list, the preview pane
  and the filter show `Beleg`, `Bezug` and `Kein Steuerbezug`; the edit
  form offers the three as one choice. "Steuerrelevant" as a word stays
  for `beleg` only.
- **Nothing is reclassified in the migration.** Existing rows become
  `beleg` where `tax_relevant` is true and `keine` elsewhere. `bezug`
  appears as documents are classified or re-run through the existing tax
  backfill (`POST /documents/tax/backfill`), which skips pinned
  documents.

## Stages

### Stage 1 — Role model, matrix, rules, API

- Migration `0261_documents_tax_role.sql`: column `tax_role text NOT NULL
  DEFAULT 'keine'` with a CHECK on the three values, backfilled from
  `tax_relevant`; journal entry; drizzle schema.
- `documents/tax-sections.ts`: `TaxRole` type, `evidence` per section
  (document types that can be evidence, optional condition), the
  Erträgnisaufstellung removed from the KAP hint and the Schulbescheinigung
  qualified in the Anlage Kind hint.
- `documents/tax-role.ts`: pure `resolveTaxRole` (LLM role + sections +
  document type + household facts → role) and the invariants, unit-tested.
- `llm-service/main.py` and `documents/classify-prompts.ts`: `tax_role` in
  the JSON schema, the response model and the prompt; `tax_relevant`
  derived for old callers; the drift-guard test updated.
- `documents/llm-client.ts`: parse `tax_role`, keep sections for `bezug`.
- `documents/tax-rules.ts`: rules return a role; the Erträgnisaufstellung
  becomes an informational marker (`bezug`); tests updated.
- `documents/document-ops.ts`: matrix after the LLM, text rules after the
  matrix, `tax_role` and the derived `tax_relevant` persisted together.
- `documents/documents.ts`: `tax_role` in summary and detail DTOs, in the
  list and search filters (`tax_role=`), in `POST /documents/:id/tax` and
  the batch tax endpoint (`tax_relevant` still accepted and mapped).

### Stage 2 — Web UI

- Detail page: three-state tag, three-way choice in the edit form, year
  only for `beleg`, hint text per role.
- List rows, preview pane and basket rows: `Steuer` badge for `beleg`, a
  muted `Steuerbezug` badge for `bezug`.
- Filter menu: `Steuer` select with the three roles (URL key `taxRole`),
  chip text per role; the old `taxRelevant` URL key still parses.
- Help page: a paragraph on the three roles.

### Stage 3 — Learning the "no"

- `learned-rules.ts`: a `(sender, document_type) → tax_role` memory from
  reviewed documents; applied last in `runClassify`; unit and integration
  tests.
- The tax endpoint keeps setting `tax_reviewed`, so every manual role
  change feeds the memory without a new flag.

### Stage 4 — Measuring

- Benchmark cases for the three user examples (Jahreszeugnis,
  Schulbescheinigung, Erträgnisaufstellung) and the counter-examples
  (Jahressteuerbescheinigung, Kindergeldbescheid) in the tax-rule tests and
  the llm-service classify tests.
- The taxonomy cockpit's gold-set evaluation (`scripts/taxonomy/`) reports
  the role confusion (beleg ↔ bezug) separately from the section accuracy.

## Status

- Stage 1 — done: migration 0261, `TaxRole` and `TAX_EVIDENCE` in
  `tax-sections.ts`, `resolveTaxRole`/`householdTaxFacts` in `tax-role.ts`,
  `tax_role` in the llm-service schema and the prompt, rules in roles,
  `validateTaxOverride` in `tax-override.ts` shared by the single and the
  batch endpoint, `tax_role` filter on list and search.
- Stage 2 — done: detail page (three-state tag, `SelectButton` in the edit
  form), list and basket rows, preview pane, filter menu (`taxRole`), help
  page, labels in `frontend/src/utils/taxRole.ts`.
- Stage 3 — done: `taxRoles` per sender and document type in
  `learned-rules.ts`, applied last in `runClassify`.
- Stage 4 — partly: the unit and integration tests carry the three
  examples and their counter-examples (`tax-role.test.ts`,
  `tax-role-integration.test.ts`, `tax-rules.test.ts`, the llm-service
  backstop tests). The role confusion in the taxonomy cockpit's gold-set
  evaluation is still open.
