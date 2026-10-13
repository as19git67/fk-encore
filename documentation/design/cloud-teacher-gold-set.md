# Design: cloud teacher for automatically growing the gold set

**Status:** Steps 1–3 implemented (persistence layer, not yet affecting the
classification). Steps 4–5 (runClassify guards, few-shot/learned-rules
filters, measurement) follow after visual inspection of the first `cloud`
labels.
**Author context:** Follows from the tax/category audit series (July 2026).

## 1. Goal and scope (important)

**What this is:** A mechanism that automatically increases the share of
**trustworthily labeled documents** by having a strong cloud model (Claude)
label a **strategic selection** of documents — with PII scrubbing as in the
existing `cloud_audit.py`. These labels replace the **manual** classification
that currently feeds the gold set / the "reviewed" examples.

**What this explicitly is NOT:** Not a replacement of the production
classification. In the future, **not** all documents will be classified via the
Claude API. The local Qwen remains the classifier for every document. Claude
only runs in a targeted way and offline, to produce **more correct examples**
where there are too few today.

**Motivation (user's own words):** "…only to increase the share of 'manually'
classified ones, to perhaps also have more correctly classified documents in
areas where there are still too few today." Exactly that: the places where one
would otherwise say "the result would be better if you had classified more
manually" are filled up automatically by Claude.

## 2. Why this helps — the existing mechanisms reward "reviewed"

The local pipeline already improves in two places when there are more
**human-confirmed** examples:

- **Few-shot** (`documents/few-shot.ts`): anchors the small model on the
  nearest already classified documents of the same household and prefers/
  filters `attributes_reviewed = true` (reviewed-only mode).
- **Learned rules** (`documents/learned-rules.ts`): derives deterministic
  sender→category/tax/tag/subject-person overrides from the documents confirmed
  by humans (thresholds: ≥3 reviewed docs + ≥75 % dominance for category, ≥2
  for the others).

Both are currently limited by the **number of manual reviews** (currently ~74
`attributes_reviewed`, ~109 `tax_reviewed`). Claude labels that are marked as
trustworthy lift exactly this limit — without manual effort.

## 3. The decisive catch: scrubbing limits WHAT Claude can teach

The audit scrubbing (`scripts/taxonomy/_common.py`) removes IBANs, amounts,
**dates**, phone numbers, long numbers, addresses, personal names and reduces
the **sender to a type** ("Bank/Broker", "Versicherung", …). That loses exactly
the signals that are needed for some fields:

| Field | Needs raw data? | Cloud teacher suitable? |
|---|---|---|
| `category_slug` | robust against scrubbing | **Yes** |
| `tax_relevant` / `tax_sections` | robust | **Yes** |
| `sender` | real name needed | **No** (scrubbed) |
| `doc_date` / `tax_year` | real date needed | **No** (scrubbed) |
| `document_number` | "#1234" needed | **No** (scrubbed) |

**Consequence:** The cloud teacher delivers trustworthy labels **only for the
category and tax axes**. Sender/date/number/tax year stay with the local
pipeline + the deterministic extractors. A "fully correctly classified via
Claude" is technically not possible with aggressive scrubbing — the scrubbing
takes away the signals the model would need for it.

**Decision:** Institutional sender names (Comdirect, HALLESCHE, Finanzamt) are
**not** PII and stay in plain text — only personal data is stripped. This gives
Claude a stronger signal for sender and category assignments, with hardly any
increased privacy risk. The teacher gets its own, **less aggressive** scrub
level (personal names/IBAN/amounts/dates out, institutional sender stays),
separate from the strict audit level (`_scrub_for_teacher()` as a separate
function next to `scrub()`/`scrub_names()` in `_common.py`, not as a parameter
of the existing ones — the audit level stays unchanged strict).

## 4. Privacy decision (to be made deliberately)

The previous cloud access is a **one-time sample audit** with a dry-run review
of the scrubbing. A **recurring** teacher batch over parts of the inventory is
a different posture. Points:

- The scrubber is regex-based and **best-effort** (address fragments/names
  supplemented via the environment variables
  `TAXONOMY_SCRUB_EXTRA_ADDRESS_FRAGMENTS` / `TAXONOMY_SCRUB_EXTRA_NAMES`, see
  `_common.py`). Fine for a batch; before continuous operation the scrubbing
  should be hardened/reviewed.
- **Dry-run obligation:** Every teacher run should, in the `AUDIT_DRY_RUN`
  style, first write the exact (scrubbed) prompts to be sent to `out/`, so that
  spot checks can be made before sending.
- Data minimization: only title/text/sender type/tags go out (as today), no raw
  PDFs.

This is a decision that must be made deliberately — it is disclosed here, not
implicitly shipped along.

## 5. Proposed architecture

### 5.1 Selection (WHICH documents does Claude label?)

Not confidence-based — Qwen is overconfident (0.95 even when wrong). Instead
targeted where the gold set is thin or Qwen is systematically weak:

1. **Sparsely populated categories/sections** — branches with very few (or
   zero) `reviewed` examples (e.g. the long-tail categories with 1–5 documents
   that are visible in the diagnosis report).
2. **Known contested axes** — e.g. `altersvorsorge-lebensversicherung` ↔
   `-rentenversicherung`, `finanzen-steuern`, real-estate sections.
3. **New documents** since the last run.
4. Optional: documents where deterministic rules (sender/content) and the LLM
   disagree.

Deduplicate against already labeled ones (like `picked_ids` in the audit).

### 5.2 Persistence (WHERE do the labels land?) — decided: separate `cloud` marker

A new provenance marker, clearly separate from raw AI output and real user
reviews — **not** simply booked as `attributes_reviewed=true`/`user`, so that a
later contradiction (e.g. the next audit) can be rolled back in a targeted way
without touching real manual reviews:

- Category: `documents.category_source` (new column, `'ai' | 'cloud' | 'user'`,
  default `'ai'`) instead of the plain boolean `attributes_reviewed`. The
  category fix stays protected (`runClassify` does not overwrite if
  `category_source IN ('cloud','user')` — analogous to the previous
  `attributes_reviewed` guard).
- Tax: extend the `document_tax_sections.source` enum by `'cloud'` (today
  `'ai' | 'user'`).
- Tags/subject persons: same pattern if needed, `source='cloud'` on the
  existing `'ai' | 'user'` columns (`document_tag_links`,
  `document_subject_persons`).

This keeps the semantics cleanly three-tiered: `ai` (raw Qwen) < `cloud`
(Claude-confirmed) < `user` (manual). **Regression protection:** precisely
because of this separation, rolling back is trivial — `DELETE ... WHERE
source='cloud'` (or setting `category_source` back to `'ai'`) automatically
falls back to the raw Qwen values, no special case needed. No additional batch
timestamp is planned — the existing `created_at` columns suffice for
traceability.

### 5.3 Feeding in (HOW does it improve the local model?)

Without new ML infrastructure, via the **existing** paths:

- **Few-shot:** allow `cloud`-verified documents as trustworthy anchors (extend
  the reviewed-only filter to `reviewed OR cloud`).
- **Learned rules:** extend the ground-truth basis from "only `reviewed`/`user`"
  to "`reviewed`/`user` **or** `cloud`". Since the thresholds (≥3, ≥75 %) are
  kept, this continues to yield only robust overrides.

Effect: more trustworthy examples → more few-shot coverage and more learned
sender overrides → the **free** local model gets better, permanently, without a
cloud call at runtime.

### 5.5 Adoption — decided: directly automatic

Claude Opus labels are persisted **without an intermediate step** with
`source='cloud'` / `category_source='cloud'` — no review-queue detour, that
would run against the purpose of the idea (replacement for manual
classification). Reasoning: Claude Opus has proven very reliable as a
classifier in the audits so far (category and tax judgments matched careful
individual review). The regression protection from 5.2 catches the rare error
case.

### 5.4 Distinction from the deterministic rules

The cloud teacher does **not** replace the deterministic rules (sender/content/
tax rules). The rules remain the cheap, immediate fix for **known systematic**
errors. The teacher addresses the **unknown long tail** that cannot be captured
by hand as a rule. They complement each other.

## 6. Cost & operation — decided: ~300–500 documents per run

- Batch size per teacher run: **~300–500 documents**, from thin branches + new
  documents + known contested axes (5.1), not the whole corpus and not on every
  reclassify.
- Requires the rate-limit hardening from PR #847 (backoff, partial result on
  abort, `AUDIT_REQUEST_DELAY`) — at this order of magnitude `429` becomes the
  normal case without it, not the exception.
- Recurring as a manual batch or cron; the result is a database update of the
  `cloud` labels, not a runtime path.

## 7. Decisions (final)

1. **Scrub level:** institutional sender stays in plain text, only personal
   data is stripped (separate, milder scrub function for the teacher, see 3).
2. **Trust level:** separate `cloud` marker (`category_source` /
   `source='cloud'`), never mixed with `reviewed`/`user`.
3. **Adoption:** directly automatic, no review queue.
4. **Scope per run:** ~300–500 documents.
5. **Regression protection:** the `cloud` provenance itself suffices
   (deletable/filterable), no additional batch timestamp.

## 8. Next step

Steps 1–3 are implemented (isolated persistence layer):

1. ✅ Schema (migration `0132_document_cloud_source`): new column
   `documents.category_source` (enum `document_category_source`
   `'ai' | 'cloud' | 'user'`, default `'ai'`, backfill `'user'` where
   `attributes_reviewed`), enum `document_tax_source` extended by `'cloud'`.
   `document_tag_links.source`/`document_subject_persons.source` are TEXT and
   already accept `'cloud'` — only the Drizzle `$type` annotations were widened
   (no DDL).
2. ✅ `_common.py`: `scrub_for_teacher()` — milder scrub level, leaves the
   institutional sender in plain text but removes the same PII as the audit.
   The strict audit level (`scrub`/`scrub_names`) stays unchanged.
3. ✅ `scripts/taxonomy/cloud_teacher.py`: dedicated teacher mode. Selection per
   5.1 (thin branches + contested axes + new documents), writes directly with
   `source='cloud'` / `category_source='cloud'` into the DB. Never touches
   `user`/`reviewed` values. `TEACHER_DRY_RUN` (or `AUDIT_DRY_RUN`) only writes
   the scrubbed prompts to `out/` for inspection. Writes a before/after report
   (`out/cloud_teacher.md` + `cloud_teacher_labels.json`) for the visual
   inspection.

Open (deliberately not yet implemented, so that the persistence can first be
verified in isolation):

4. `runClassify` guards (on `category_source` instead of only
   `attributes_reviewed`) and extending the few-shot/learned-rules filters to
   `cloud` (5.2/5.3). Until then a normal reclassify overwrites the `cloud`
   category again — until step 4 the labels are only there for inspection. The
   frontend badges (`source === 'ai'`) also only treat `'cloud'` separately
   with step 4.
5. Measure: diagnosis/audit run before/after, to quantify the effect on thinly
   populated branches.

The recommendation remains: step 4 only after visual inspection of the first
`cloud` labels.
