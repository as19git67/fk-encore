# Related documents: origin folder, dossiers, reference numbers, duplicates

## Problem

Before fk-encore the household's documents lived in a folder tree, and the
folder *was* the context: the insurance policy, its terms and conditions,
the general terms, and every later letter sat side by side. After import
that context is gone. Search finds the one document that carries the
policy number, but the terms and conditions never mention the number, so
nothing leads from the one to the others.

What the code does today (October 2026):

- `importDocumentFromPath` keeps only `original_filename`. The inbox
  watcher (`inbox-watcher.ts`) walks subfolders, but the subfolder is not
  recorded anywhere. `disk_path` is the *new* location by category, not the
  origin.
- There is no "dossier". The document carries a category, a document type,
  a correspondent (`correspondent_slug`), tags, subject persons and
  collection memberships (Sammelmappen). None of these says "these seven
  documents belong to contract X".
- Contract, policy and customer numbers are thrown away on purpose:
  `document_number` accepts only the explicit `#1234` sticker
  (`metadata-extract.ts`), and the model's free-form number guess is
  discarded as noise for *that* field.
- A second copy of a document can enter the corpus with a different
  `sha256`. The original bytes in `DOCUMENTS_DIR` are immutable, but the
  served file is not always the original: the searchable "sandwich" PDF and
  the upright copy live in `_ocr/<id>.pdf` (`ocr-pdf.ts`), and the download
  endpoint hands those out. Re-importing from the documents volume or from
  downloads therefore creates near-duplicates the unique `sha256` cannot
  catch.

## Decisions

- **The origin folder is data, not structure.** It is stored as a plain
  relative path on the document and used as one more link between
  documents; it never decides where a file lives or how it is categorised.
- **Dossiers are collections with a rule.** A long-lived file ("Hausrat at
  insurer Y") reuses the Sammelmappe: list, detail page, summary cron and
  PDF export already exist. A collection gains an optional membership rule
  (correspondent + reference number); a rule-matching document joins
  automatically after classification. No second folder-like entity.
- **Reference numbers are a field of their own**, separate from
  `document_number`, typed (insurance, contract, customer, case number),
  extracted by regex first and model second, searchable and clickable.
- **Relatedness is explained.** The detail page groups suggestions by the
  reason they are suggested (same folder, same correspondent close in time,
  same dossier, semantically close) so the user can judge each one.
- **No "scan session" grouping.** Rejected: documents arriving in the inbox
  within minutes of each other are not reliably one envelope.
- **Duplicates are merged, not just deleted.** The copy that goes carries
  user work (tags, collection memberships, subject persons, tax review,
  finance links, follow-ups, pinned attributes); that work moves to the
  copy that stays. Deletion then runs through the existing
  `deleteDocument` path so files, `_ocr`, thumbnails and `_steuer` links
  are cleaned the same way as a manual delete.
- **Every maintenance action runs dry first.** Backfill and merge both
  produce a report before they write anything; the report is what the user
  checks.

## Stages

### 1. Origin folder (`source_folder`) and backfill (#1477)

- Migration: `documents.source_folder TEXT NULL` plus index. Relative path
  of the file's directory under the inbox root (or under the uploaded
  folder for a browser folder upload), `/`-separated, no leading slash,
  `NULL` for a single file dropped at the root.
- `importDocumentFromPath` takes `sourceFolder`; the watcher derives it
  from `path.relative(DOCUMENTS_INBOX_DIR, dirname(file))`. The upload
  endpoint accepts it from `webkitRelativePath` when the browser sends a
  folder.
- Backfill endpoint `POST /documents/source-folder/backfill` (admin,
  `data.manage`): takes a root path on the server (the old folder tree,
  mounted read-only), walks it, hashes every supported file and writes
  `source_folder` for the row whose `sha256` matches. Files that match no
  row and rows that match no file are listed in the report, never touched.
  Dry run by default; `apply: true` writes. Hashing is the same
  `crypto.createHash("sha256")` streaming the whole file that `fsck.ts`
  uses.
- Detail page shows the folder as a breadcrumb; each segment is a link to
  the list filtered by `source_folder` prefix (`folder=` in `route.query`,
  through `ListToolbar` like every other filter).

### 2. "Related documents" panel on the detail page (#1478)

Endpoint `GET /documents/:id/related` returning groups, each with a
`reason` and up to N items, all filtered by `visibleDocumentsWhere` so
nothing leaks across groups:

- `same_folder`: equal `source_folder`, newest first.
- `same_correspondent_nearby`: equal `correspondent_slug`, `doc_date`
  within ±30 days. This is the letter with its enclosed terms.
- `same_collection`: other members of the collections this document is in
  (one group per collection, titled by it).
- `semantic`: nearest neighbours from `document_embeddings` by cosine
  distance, excluding what the other groups already show, with a distance
  cutoff so an empty result is possible.

A document already shown in an earlier group is not repeated in a later
one. Each item carries the one-click actions "add to collection" (reuses
`AddToCollectionDialog`) and later "add to dossier". The panel lives in
`DocumentDetailView.vue` next to the Sammelmappen card and loads lazily
after the document itself.

### 3. Reference numbers (#1479)

- Migration: `documents.reference_numbers JSONB NOT NULL DEFAULT '[]'`,
  shape `{ kind: 'insurance' | 'contract' | 'customer' | 'case' | 'other',
  value: string, normalized: string, source: 'regex' | 'model' | 'user' }[]`,
  with a GIN index on the normalized values for the equality lookup.
- `metadata-extract.ts` gains `extractReferenceNumbers(text)`: label-led
  regexes for the common German forms ("Versicherungsnummer",
  "Versicherungsschein-Nr.", "Vertragsnummer", "Kundennummer",
  "Aktenzeichen", "Policen-Nr.", "Vorgangsnummer" …), the value normalised
  by dropping spaces, dots and dashes and upper-casing. The classifier
  prompt asks for the same list and the two are merged, regex winning on
  conflict. User edits set `source: 'user'` and are protected by
  `attributes_reviewed` like the other pinned attributes.
- Search: `q` matches a normalised reference number exactly (in addition
  to FTS over the text). List filter `ref=<normalized>`. On the detail page
  every number is a chip linking to that filter.
- Tests follow the pattern of `metadata-extract.test.ts` with synthetic
  numbers only (see "Keine personenbezogenen Daten" in CLAUDE.md).

### 4. Dossiers: collections with a membership rule (#1480)

- Migration on `document_collections`: `rule JSONB NULL` with
  `{ correspondent_slug?: string, reference_numbers?: string[] }` (normalised
  values), `kind TEXT NOT NULL DEFAULT 'manual'` (`'manual' | 'dossier'`),
  and on `document_collection_items` a `joined_by TEXT NOT NULL DEFAULT
  'user'` (`'user' | 'rule'`) so a rule can withdraw only what a rule added.
- After classification (`document-ops.ts`, where `correspondent_slug` and
  the new `reference_numbers` are final) a document is matched against the
  rules of every collection its owner or group can see; a match inserts a
  membership with `joined_by = 'rule'`, `summary_stale = true`. Visibility
  is checked with the same `assertMembersFitVisibility` the manual add
  uses.
- Creating a dossier from the detail page pre-fills the rule from the
  document's correspondent and reference numbers. "Apply rule now" on the
  collection detail page runs the match over the existing corpus.
- A document without any reference number (terms and conditions) joins
  through the related panel (stage 2) with one click, or via a rule entry
  `source_folder` prefix added to the rule shape in this stage.

### 5. Near-duplicate detection and merge (#1481)

**Detection** (`documents/duplicates.ts`, endpoint
`POST /documents/duplicates/scan`, admin): candidate pairs within the same
owner or group, then scored. Prefilter cheaply, confirm expensively:

1. Prefilter: equal `pages_total`, and either equal `doc_date`, equal
   `correspondent_slug`, or embedding cosine distance below a threshold
   (`document_embeddings` already exists for every classified document).
2. Confirm: normalised `extracted_text` (whitespace collapsed, lower-cased,
   digits kept) compared by trigram Jaccard in the service (pg_trgm is not
   installed and this is a one-off), accept above 0.85. A sandwich copy of
   an OCR'd scan reads almost identically; an upright copy reads
   identically.
3. Evidence recorded per pair: both ids, the score, which prefilter hit,
   `text_source` of each (`ocr` on one side and `text_layer` on the other
   is the signature of "original scan vs. its re-imported sandwich"), and
   whether one `original_filename` has the speaking-name shape
   `relocate.ts` produces (a re-import from the documents volume).

Results are persisted in `document_duplicate_candidates` (pair, score,
evidence, `status: 'open' | 'merged' | 'dismissed'`) so a dismissed pair
is not proposed again, and shown under Dokumente › Einstellungen ›
Datenverwaltung as a review list with side-by-side thumbnails.

**Keeper rule** (default, overridable per pair in the UI): keep the
document whose file is the original bytes, i.e. `text_source = 'ocr'`
over `'text_layer'` when the pair is scan-vs-sandwich; otherwise keep the
lower id (the earlier import). The other one is the *loser*.

**Merge** (`POST /documents/duplicates/:pairId/merge`), in one
transaction under `withDocumentLock` for both ids:

- Attributes: if the loser is `attributes_reviewed` and the keeper is not,
  copy title, doc_date, sender, document_number, summary, category,
  `category_source`, `reference_numbers` and set `attributes_reviewed`.
  Same for the tax fields guarded by `tax_reviewed`.
- Rows pointing at the loser are re-pointed to the keeper, skipping those
  that would violate a unique constraint because the keeper already has
  them: `document_tag_links`, `document_collection_items` (keep the loser's
  `excluded_pages`/`included` only where the keeper has no row),
  subject-person links, `document_tax_sections`,
  `finance_transaction_document`, `finance_document_match_suggestion`,
  `finance_depot_document_ignore`, `finance_bankcontact`,
  `finance_document_settlement_llm`, follow-ups, scan-queue rows are
  dropped. The list is derived from the FK references to `documents.id`
  in `db/schema.ts` and asserted by a test so a new table cannot be
  forgotten silently.
- `source_folder`: keep the keeper's, fill from the loser if empty.
- Then `deleteDocument`'s internals run for the loser (tax links, row,
  file, thumbnail, `_ocr`), and the pair row becomes `merged` with the
  keeper id.

**Prevention**: the import path runs the same detection against the new
document once its text is extracted (a scan-worker step after
`text_extract`). A hit above the threshold does not block the import; it
records an open pair and flags the document in the list ("possible
duplicate of #id"), which is where the review list starts.

### Order

1 and 2 first: small schema change, one backfill, and the lost folder
context is back with suggestions visible immediately. 5 next, because the
corpus should be clean before dossiers start pulling documents in by rule.
Then 3 and 4.

## Open points

- Threshold for the trigram score and the embedding prefilter need a pass
  over the real corpus in dry-run mode before they are fixed; the report
  from stage 5's scan is for that.
- Whether the browser folder upload is worth a UI change in
  `DocumentUploadView.vue` or whether the inbox is the only folder path.
