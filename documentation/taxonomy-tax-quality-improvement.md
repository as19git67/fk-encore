# Plan: improve taxonomy & tax classification in a data-driven way

Status: **Draft for review — no implementation yet.**
Goal: From the already ingested documents of the past years, derive a complete,
robust taxonomy and a complete hints inventory for the tax classification
**once**. Preferably local; cloud only for a few hundred **anonymized**
representatives where a strong model brings real added value.

---

## 0. Starting point (current state in the code)

- **Taxonomy**: fixed in `documents/taxonomy.ts` (12 top categories + ~40
  subcategories), seeded via `db/seed.ts` → table `document_categories`.
  Optional `hint` fields per category. **No** runtime override for taxonomy
  hints.
- **Tax sections**: 30 fixed slugs in `documents/tax-sections.ts`, each with a
  `hint`. Hints can be tuned at runtime via the table
  `tax_section_hint_overrides` (`documents/tax-hint-overrides.ts`).
- **Classification**: local Llama GGUF (`llm-service/main.py`), **zero-shot**,
  JSON grammar, `temperature=0.2`, `max_tokens=768`. The prompt contains the
  taxonomy outline, tax sections (grouped) and subject persons.
- **Household context for the tax decision**: The subject-persons list carries
  `relation_kind`, `tax_cost_bearer` and `in_household`; in addition there is
  the assessment type (`assessment_type`). The `PERSONENBEZUG` block in
  `CLASSIFY_TAX_PROMPT` thus distinguishes a clear deduction of the user
  (spouse with joint assessment, own child in the household) from an open case
  (parents, wards), instead of suppressing every subject person across the
  board. The age limit for children (§ 32 para. 4 EStG) is only evaluated by
  the downstream review derivation — the classifier does not get a date of
  birth.
- **Embeddings**: `intfloat/multilingual-e5-base` (768-dim), stored per document
  chunk in `document_embeddings`.
- **Data already persisted per document** (the raw material of this plan):
  - `documents.extracted_text` (full OCR text)
  - `documents.summary` (1–2 neutral German sentences), `tags`
  - `documents.classification_confidence`, `documents.sender`, `documents.doc_date`
  - `documents.tax_relevant`, `tax_year`, `tax_year_confidence`, `tax_reviewed`
  - `document_tax_sections` (document_id, tax_section, confidence, source ∈ {ai,user})
  - `document_embeddings` (document_id, chunk_idx, embedding)

**Consequence:** We do **not** have to run the thousands of PDFs through OCR/LLM
again. Everything for clustering, representative selection and hint mining is
already in the DB.

### 0.1 How much does the plan depend on manually corrected documents?

**Answer: little — and deliberately asymmetric.** The taxonomy derivation
(stage B/C) is **unsupervised** and needs no manual labels at all; it works only
on the embeddings. The plan uses manual corrections exclusively where the schema
cleanly marks them as "confirmed by a human" — and that is unevenly
distributed:

| Field | Manual signal in the schema | Usable as "truth"? |
|-------|----------------------------|-------------------------|
| Tax relevance / `tax_year` | `documents.tax_reviewed` (→ true on user edit) | **Yes, cleanly** |
| Tax sections | `document_tax_sections.source ∈ {ai, user}` | **Yes, cleanly** |
| Category | **no** `source`/`reviewed` flag on `category_id` — a user correction overwrites the AI value indistinguishably | **No** |
| Tags | `document_tag_links` has **no** `source` column (unlike finance tags) | **No** |

**Consequences for the plan:**
- The manual dependency is limited to the **tax gold set** (stage A/F:
  `tax_reviewed=true`, `source='user'`) and the **few-shot positive examples**
  (stage E). If this set is small, only the eval gate is weaker — the taxonomy
  derivation remains unaffected.
- For **category and tags**, **no** gold set can be built automatically from the
  DB (no marker). That is why the manual review of the ~150–400 representatives
  (stage C/F) deliberately serves as a substitute for the missing signal.
- **Stage A counts first of all** the existing quantities (`tax_reviewed=true`,
  `source='user'` sections, corrected shares), so that we know whether the gold
  set suffices for the eval gate or has to be topped up by manual review.

**Optional future fix (not a prerequisite for this one-time run):** a
`category_source` column (`ai`/`user`) on `documents` and a `source` column on
`document_tag_links` — analogous to the tax sections. Then *future* category/tag
corrections become minable, and the reclassify no longer overwrites them. Makes
the next iteration considerably stronger.

---

## 1. Guiding principles

1. **Measure first, then change.** No taxonomy operation without diagnosis
   numbers.
2. **Local first.** Clustering, representative selection, mining run entirely
   locally (Python, existing `llm-service` environment + sklearn/hdbscan).
3. **Cloud only for representatives, only anonymized.** At most a few hundred
   `summary` texts (not raw OCR), after PII scrubbing.
4. **Versionable.** Results (taxonomy, hints) land as code diffs in
   `taxonomy.ts` / `tax-sections.ts` or as reproducible seed files — no
   undocumented manual DB changes.
5. **Measurement loop.** Before/after accuracy on a small gold set, otherwise
   "better" cannot be verified.
6. **One-time character.** Everything under `scripts/taxonomy/` as offline tools
   that do not touch production (read-only on the DB, output as files for
   review).

---

## 2. Tool and storage structure (planned)

```
scripts/taxonomy/
  00_diagnose.py        # Read-only report on current assignments
  01_doc_vectors.py     # Chunk embeddings → 1 vector/document (mean-pool)
  02_cluster.py         # HDBSCAN/hierarchical → clusters + outliers
  03_representatives.py # Medoids + diversity sampling + problem cases
  04_anonymize.py       # PII scrubbing of the representative summaries
  05_propose_taxonomy.* # (local OR cloud) name clusters + propose tree
  06_mine_hints.py      # Sender/keyword/confusion mining per category+section
  07_write_hints.*      # (local OR cloud) formulate final hints
  08_eval.py            # Gold set: before/after accuracy
  out/                  # Reports, proposals, anonymized exports (gitignored)
```

DB access from Python via `psycopg` + pgvector against the Encore Postgres
instance (read-only role). Clustering with `numpy`/`scikit-learn`/`hdbscan` (new
dev deps, only for the scripts — not in the runtime image of the
`llm-service`).

---

## 3. Stage A — Diagnosis (read-only, local, ~1 day)

**Script:** `00_diagnose.py`. `SELECT` only. Output: `out/diagnose.md`.

Metrics:
- Distribution over `document_categories` including the **`sonstiges` share**
  (miscellaneous) and the share with `classification_confidence < 0.5`. →
  Taxonomy gaps.
- Histogram of `classification_confidence` overall and per top category.
- Tax sections: number of documents per `tax_section` (source='ai'); sections
  assigned **never** and **almost always**; mean confidence per section. → Dead
  / overloaded sections.
- Most frequent `sender` per category and per tax section. → Overlaps become
  visible.
- **Confusion heuristic** (uses embeddings, without labels): for each document
  the k=10 nearest neighbors; share whose majority lies in a *different*
  category than the document itself → list of likely misclassifications,
  grouped by "from category X wrongly like Y".
- `tax_reviewed=true` documents are marked as a **mini gold set** (truth
  confirmed by the user) and set aside for stage F.

**Decision outcome:** The report says whether the problem is primarily structure
(stage C), hints (stage D) or model (stage E).

---

## 4. Stage B — Document vectors & clustering (local)

**`01_doc_vectors.py`**
- Loads all `document_embeddings`, **mean pooling** over chunks → one
  L2-normalized 768-dim vector per document. Persisted as `out/doc_vectors.npy`
  + ID index.

**`02_cluster.py`**
- **HDBSCAN** (finds the number of clusters itself, marks outliers as `-1`) as
  default; optionally agglomerative/Ward for an explicit **hierarchy**, if we
  want to derive the tree structure directly.
- Output `out/clusters.json`: cluster ID → document IDs, cluster size,
  intra-cluster cohesion, outlier list.
- Sanity check: cross-tabulate clusters against existing categories — shows
  which clusters cleanly correspond to one category, which mix two categories
  (merge candidate) and which lie across `sonstiges` (new category).

---

## 5. Stage C — Representatives & taxonomy proposal

### 5.1 Picking the representatives (`03_representatives.py`, local)

Three sources combined, target ~150–400 documents in total:
- **Medoids**: per cluster the most central document + k nearest (typical
  representatives).
- **Diversity sampling**: max-min/facility location over all vectors (covers the
  breadth, catches rare things).
- **Problem cases**: low confidence, `sonstiges`, HDBSCAN outliers (show
  edges/gaps).

Output `out/representatives.json` (document IDs + source + `summary` + `tags` +
`sender`).

### 5.2 Anonymization (`04_anonymize.py`, local — mandatory before any cloud step)

On `summary`/`tags`/`sender` of the representatives:
- Mask names from the **subject-persons list** (table exists).
- Regex/Presidio: IBAN, tax/social IDs, addresses, phone, e-mail, monetary
  amounts, dates of birth → placeholders (`[BETRAG]`, `[NAME]`, `[ADRESSE]` …).
- **Only `summary` + `tags` + sender *type*** (e.g. „Bank", „Finanzamt" (tax
  office), „Arzt" (doctor)) leave the machine — **no** raw OCR, no real names.
- Output `out/representatives.anon.jsonl` + a diff report showing what was
  masked (for visual inspection before the upload).

### 5.3 Propose taxonomy (`05_propose_taxonomy`)

- **Local variant**: the existing Llama names/groups the clusters from the
  anonymized summaries. Cheap, data-safe, possibly coarser.
- **Cloud variant (recommended, anonymized)**: the ~150–400 anonymized
  representative summaries go **once** to a strong model (Claude) with the task:
  propose a complete, hierarchical taxonomy, existing `taxonomy.ts` as the
  starting point, explicitly justify gaps/merges.
- Output `out/taxonomy.proposal.md`: proposed tree + mapping "old slug → new
  slug" + justification per change. **Pure proposal** — adoption after manual
  review as a diff in `taxonomy.ts` (+ `seed.ts` stays idempotent; slug
  renamings need a small migration for `document_categories`).

---

## 6. Stage D — Complete hints inventory

### 6.1 Mining (`06_mine_hints.py`, local)

Per taxonomy category **and** per tax section, aggregate from the actually
assigned documents:
- Top senders (real institution names → concrete hint examples).
- Characteristic keywords (TF-IDF against the rest of the corpus).
- **Confusion pairs** from stage A → candidates for "NICHT: … → andere-sektion"
  rules ("NOT: … → other section"; exactly the pattern that today's hints
  already use, e.g. `anlage-n` vs `anlage-kap`).
- Output `out/hints.mining.json`.

### 6.2 Formulating (`07_write_hints`)

- From the mining, formulate a final `hint` per slug (local or cloud, input only
  aggregated/anonymous statistics — no individual documents needed).
- Output:
  - **Tax sections** → directly as upserts into `tax_section_hint_overrides`
    (existing mechanism, immediately effective, reversible) **or** as a diff in
    `tax-sections.ts`. Recommendation: first the override table (A/B-capable),
    after proving itself write back into the source code.
  - **Taxonomy categories** → there is currently no override mechanism. Two
    options:
    - (a) Write hints directly back into `taxonomy.ts` (versioned, simple, fits
      the one-time character) — **recommended**.
    - (b) New table `taxonomy_hint_overrides` + merge in
      `loadTaxonomyForClassifier()` (more effort, but tunable at runtime like
      the tax sections). Only if you want to change hints without a deploy in
      the long term.

---

## 7. Stage E — Reliability levers (optional, independent)

If diagnosis/eval shows that even with better hints too much is off:
- **Few-shot / retrieval-augmented classification**: before the LLM call, pull
  the k most similar documents already classified **correctly** (ideally
  `tax_reviewed`/`source=user`) via embedding and give them as examples in the
  prompt. Fully local, uses existing embeddings. Biggest expected jump.
- **Model upgrade**: larger local GGUF (e.g. Qwen2.5-14B/32B-Instruct), if the
  small model is the bottleneck. Config/infra only, not a privacy topic.

This stage is a **permanent** improvement of the pipeline, not a one-time job —
hence deliberately separate and only if needed.

---

## 8. Stage F — Validation (mandatory gate)

- **Gold set**: the `tax_reviewed=true` documents (confirmed by the user) + the
  manually reviewed representatives.
- `08_eval.py`: classifies the gold set with **old** vs **new** taxonomy/hints
  and reports top-1 accuracy for category, `tax_relevant`, `tax_year` and tax
  section (precision/recall per section).
- **Gate:** Changes to `taxonomy.ts`/hints are only adopted if the new variant
  is not worse on the gold set. Result as `out/eval.md`.
- Afterwards: reclassification of the corpus via the existing reclassify
  pipeline (re-enqueue documents) — existing `source=user` assignments remain
  untouched.

---

## 9. Order & effort (recommendation)

| # | Stage | Local/Cloud | Effort | Benefit |
|---|--------|-------------|---------|--------|
| 1 | A Diagnosis | local | ~1 day | decides everything else |
| 2 | D Hints | local (+ optional cloud formulation) | small | often already a big effect, fully versionable |
| 3 | B+C Taxonomy | local + anonymized cloud | medium | if diagnosis shows structural gaps |
| 4 | F Eval | local | small, but mandatory gate | makes "better" verifiable |
| 5 | E Few-shot/model | local | medium | permanent reliability, only if needed |

---

## 10. Open points for your decision

1. **Slug renamings** in the taxonomy: allowed (clean structure, but migration
   for `document_categories` + re-mapping of existing assignments needed) — or
   only **additive** changes (new subcategories, no renaming)?
2. **Hints storage**: tax sections via override table (reversible, A/B) or
   directly in the source code? Taxonomy hints option (a) source code vs (b) new
   table?
3. **Cloud model**: Confirmation that anonymized summaries may go to Claude
   (otherwise strictly local with a somewhat coarser result).
4. **Reclassification**: reclassify the entire corpus, or only the documents
   that are uncertain/`sonstiges` today?

> Nothing in this plan changes production data. All scripts are read-only on
> the DB; results are files for review. Adoption happens only after your OK
> and after passing the eval gate (stage F).
