# Document folder structure & group concept (formerly households)

This document describes how uploaded documents are stored on disk under
`DOCUMENTS_DIR` and how documents can be shared between individuals and groups
(e.g. families or sub-areas of a household).

Status: implemented in migration `0036_documents_households`; the
correspondent level (section 3a) was added in migration `0130`/`0131`.

---

## 1. Goals

- **Browsable in the file system**: A user should be able to navigate directly
  to the invoice or notice they are looking for on a file share, even without
  the web app.
- **Descriptive file names**: `[YYYY_][#documentnumber_]<sender>_<title>__<hash8>.pdf`
  instead of opaque SHA-256 shards.
- **Move on reclassification**: If the category, the date, the sender or the
  visibility changes, the file automatically moves to its new canonical place.
- **Per-person isolation**: A user's private documents are not visible to
  others — neither in the UI nor in the file system.
- **Group pool**: A shared group (e.g. a family or just the parents) can use a
  shared document store, so that the parent who picked up the mail from the
  mailbox does not remain the exclusive owner of the scanned notices.
- **Tax view via hardlink**: Tax-relevant documents additionally appear under
  `_steuer/<year>/<anlage>/` as a hardlink to the canonical file — without
  duplicating the bytes.
- **Grouped by correspondent**: Within a category, all documents from the same
  sender (and, where recognizable, the same contract) lie together in one
  folder — instead of being scattered by year only. See section 3a.

---

## 2. Visibility model

A document has exactly one visibility:

| `visibility`  | `user_id`     | `group_id`     | Who sees it?                             |
|---------------|---------------|----------------|------------------------------------------|
| `private`     | uploader      | `NULL`         | only the uploader                        |
| `group`       | uploader      | group ID       | every member of this group               |

The uploader (`user_id`) is retained in both cases — group documents also
nominally "belong" to the person who scanned them. Admin mutations (delete,
switch visibility) are allowed for the uploader *or* a group owner — see
`loadAdministrableDocument` in `documents/visibility.ts`.

The database enforces the consistency rule as a CHECK constraint:
`(visibility='private' AND group_id IS NULL) OR (visibility='group'
AND group_id IS NOT NULL)`.

Deleting a group is blocked by `ON DELETE RESTRICT` as long as documents are
still attached to it — so that nobody accidentally orphans group documents.

### Group roles

- `owner` — may add/remove members, rename the group, delete documents of other
  members.
- `member` — sees all group documents, may upload their own, but may not delete
  documents of others.

---

## 3. Folder scheme

```
DOCUMENTS_DIR/
├── <user-login-slug>/                                  ← private documents
│   ├── _inbox/YYYY-MM/                                 ← not yet classified
│   ├── <category-path>/<correspondent>/*.pdf           ← classified
│   └── _steuer/<year>/<anlage>/*.pdf                   ← hardlinks in tax view
└── _gruppe/<group-slug>/                            ← group documents
    ├── _inbox/YYYY-MM/
    ├── <category-path>/<correspondent>/*.pdf
    └── _steuer/<year>/<anlage>/*.pdf
```

`<correspondent>` is the folder segment described in section 3a; the
`_steuer/` view is deliberately kept organized by year/anlage, without a
correspondent level.

The canonical storage has no additional year folder. The year is already at the
beginning of the descriptive file name; documents of different years therefore
lie together in the folder of their correspondent and are still grouped
lexicographically by year.

Individual categories can define an additional `filesystemGrouping` dimension
in the taxonomy. It is inserted into the path directly after the configured
category and is currently formed from the subject persons linked to the
document. This yields, for example:

```
betreuung/erika-mustermann/betreuung-rechenschaftsbericht/amtsgericht-augsburg/*.pdf
```

The following root categories are currently configured:

- `betreuung`: The person is mandatory for storage. Without an assignment,
  `_ohne-betreuten` is used, with several persons `_mehrere-betreute`.
- `gesundheit`, `familie`, `vereine`, `bildung`: The person dimension is only
  added if a subject person is linked. The user's own documents therefore keep
  the previous short path. Several persons end up under
  `_mehrere-bezugspersonen`.

The person's name is normalized with the same safe slug procedure as other
folder segments. Assigning, removing or renaming a subject person triggers a
renewed filing of the affected document. Which categories group is not
hard-coded in the path builder but is defined centrally in
`documents/taxonomy.ts`.

The `<user-login-slug>` is derived from the local part of the e-mail address
(`max.mueller@example.com` → `max-mueller`). For purely numeric or empty local
parts the algorithm falls back to `user-<id>`.

The `<group-slug>` is generated from the group name on creation and is
`UNIQUE` in the schema.

The file name scheme is:

```
[YYYY_][#documentnumber_]<sender-slug>_<title-slug>__<hash8>.pdf
```

The year prefix comes from the document date (`doc_date`). If there is no
document date, the year prefix is omitted and instead the upload date
`YYYY-MM-DD` remains as a fallback component in the file name. The document
number is prefixed with `#` if present.

Examples:

- `2026_#2661160_finanzamt-muenchen_bescheid__a1b2c3d4.pdf`
- `2026_finanzamt-muenchen_bescheid__a1b2c3d4.pdf`
- `#2661160_2026-04-17_finanzamt-muenchen_bescheid__a1b2c3d4.pdf`

Missing components are omitted (document without sender →
`2026_<title>__<hash8>.pdf`). The `__<hash8>` suffix is the first 8 hex digits
of the SHA-256 and guarantees uniqueness even if two documents from the same
sender in the same year with the same title are uploaded.

---

## 3a. Correspondent level

The `sender` extracted by the AI classification is free text and, taken by
itself, too unstable to serve as a folder name — "Janitos",
"Janitos Versicherung AG" and "Janitos AG" would otherwise produce three
different folders. That is why the sender is first mapped to a **stable
correspondent identity** (`documents/correspondent.ts`) before it flows into
the path.

### Structure of the folder slug

```
<sender>[-<product>][-<contract-anchor>]
```

- **`<sender>`** — comes from a curated registry of known institutions
  (`documents/institutions.ts`, e.g. `janitos`, `comdirect`, `barmer`).
  Unknown senders fall back to a slugified raw name (long tail, slight
  fragmentation possible — see overrides below).
- **`<product>`** — optional, from a keyword table over the **title** of the
  document (`privathaftpflicht`, `hausrat`, `kfz`, `leben`, …). Only the title
  is checked, so that incidental mentions in the body text do not put a
  document into the wrong product drawer.
- **`<contract-anchor>`** — optional, from the already existing reference tags
  `versicherungsnr:…` or `vertragsnr:…` (`versicherungsnr` takes precedence).
  Appended as soon as present — so that several contracts of the same provider
  and the same line of business do not end up in one folder (e.g. two personal
  liability policies at Janitos). Deliberately **not** `document_number`: this
  field is per document, not per contract (see issue #664 in
  `documents/metadata-extract.ts`).

Examples: `janitos-privathaftpflicht-4711884`, `janitos-hausrat`,
`comdirect` (sender only, no product/contract recognized). Without a
resolvable sender: the placeholder segment `_ohne-absender`.

### Persistence

The resolved identity (`correspondent_slug`, `correspondent_display`) is
additionally persisted on the `documents` row (migration `0130`) — not only in
the path. It is written by `relocateDocument`, regardless of whether the file
is actually moved. This enables filtering/grouping "by correspondent" in the
document list without re-deriving the sender on every query
(`GET /documents/correspondents` for the facet, `?correspondent=<slug>` as a
filter on `GET /documents` and on search).

### User overrides

If the automatic assignment does not fit (e.g. an unknown sender is to be
merged with an existing correspondent, or a misassignment is to be corrected),
a user can create a sender pattern → correspondent mapping in the maintenance
page under „Korrespondenten-Overrides" (correspondent overrides)
(migration `0131`, `documents/correspondent-overrides.ts`). An override beats
the built-in registry and takes effect as soon as the affected document is
filed again (reclassification or „Dateipfade aktualisieren" (update file
paths)). If several patterns match, the longest and therefore most specific
pattern always wins, regardless of the order in the database. Overrides are
household-wide (not per user) and are cached with a short TTL, so that the
bulk move does not query per document.

### Single source of known institutions

The correspondent registry is derived from `documents/institutions.ts` instead
of maintaining its own list. `documents/institutions.test.ts` checks that
every sender fragment used there is also known in the sender routing rules
(`documents/sender-rules.ts`) — so the two lists cannot diverge without a test
failing.

---

## 4. Lifecycle of a file

1. **Upload** (`POST /documents` or inbox watcher): The file lands under
   `<owner-root>/_inbox/<YYYY-MM>/<sha256>.pdf`. The visibility is initially
   `private` — moving it up into a group is done actively by the user via the
   UI.
2. **Classification** (worker pipeline `text_extract → classify → embed`): The
   `classify` job writes category, date, sender, title and tax fields into the
   DB. Afterwards it calls `relocateDocument(id)` — which resolves the
   correspondent identity (section 3a), moves the file to its canonical place
   and builds the tax hardlinks.
3. **User correction** (`PATCH /documents/:id`): Changing one of the fields
   triggers `relocateDocument` again. The move operation is idempotent — if the
   file is already in the right place, nothing happens except a rebuild of the
   tax links. This also applies to the assignment of a subject person, provided
   the category uses a `filesystemGrouping` dimension.
4. **Visibility change** (`POST /documents/:id/visibility`): Moves the document
   between the private area and the group area; the file moves to the
   corresponding owner root, old tax hardlinks are cleaned up.
5. **Delete** (`DELETE /documents/:id`): Removes the tax hardlinks first, then
   the DB entry (cascades tags + tax assignments), then the canonical file, and
   cleans up empty folders upwards.

`relocateDocument` is implemented in `documents/relocate.ts`. It is
cross-device-safe (falls back to `copy+unlink` on EXDEV) and secured against
path traversal (`assertPathUnderDocumentsRoot` before every fs operation).

---

## 5. Relevant modules

| `db/migrations/postgres/0036_…`   | Schema extension: households (now groups)      |
| `db/migrations/postgres/0069_…`   | Rename households -> groups                    |
| `db/migrations/postgres/0130_…`   | Persisted correspondent columns on `documents`     |
| `db/migrations/postgres/0131_…`   | Table for correspondent overrides                    |
| `documents/documents.service.ts`  | Path builder (`resolveDocumentDiskPath`, slugifier, …)   |
| `documents/relocate.ts`           | Physical moves + tax hardlink rebuild + correspondent persistence |
| `documents/correspondent.ts`      | Sender → correspondent (+ product, contract anchor)      |
| `documents/institutions.ts`       | Registry of known institutions (single source, section 3a) |
| `documents/correspondent-overrides.ts` | Loading/cache of the user overrides                    |
| `documents/visibility.ts`         | Access control (`loadVisibleDocument`, …)             |
| `documents/groups.ts`             | API endpoints for managing groups                  |
| `documents/documents.ts`          | `POST /documents/:id/visibility`, upload, CRUD, search, correspondent facet + override CRUD |
| `documents/import.ts`             | Import logic for documents                               |

---

## 6. Updating existing files

Documents uploaded before version 0036 lie under the old
`YYYY/YYYY-MM/<sha256>.pdf` scheme. Migration 0036 only changes the DB schema —
the files only move when the file paths are explicitly updated.

For this, the maintenance page offers, next to „Nur KI-Klassifikation" (AI
classification only) and „OCR + Klassifikation" (OCR + classification), the
action **Dateipfade aktualisieren**. Technically it calls
`POST /documents/relocate-all`. The endpoint requires `data.manage`, iterates
over all documents, calls `relocateDocument` on each one and reports back how
many documents were checked, moved or failed.

`relocateDocument` is idempotent: repeated calls are harmless.

The same mechanism also covers the introduction of the correspondent level
(section 3a, migration `0130`): `relocateDocument` always derives the path and
correspondent columns freshly from the current metadata, so a single click on
**Dateipfade aktualisieren** is enough to transfer the entire legacy inventory
into the new folder structure and to fill the persisted correspondent fields —
without its own migration/backfill logic. This applies equally to the removal
of the former year folder level and to the configured subject-person folders:
the existing DB links are evaluated during the run and the files are moved
accordingly.
