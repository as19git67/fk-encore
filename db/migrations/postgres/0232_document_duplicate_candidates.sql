-- Near-duplicate candidates (#1481).
--
-- The stored original of a document is immutable, but the file the app hands
-- out is not always the original: the searchable "sandwich" PDF and the
-- upright copy under `_ocr/` differ byte for byte from what was uploaded. A
-- re-import from the documents volume or from a download therefore creates a
-- second document the unique `sha256` cannot catch. The scan finds such pairs
-- by content and records them here, so a pair dismissed by a person is not
-- proposed again and a merged pair keeps the trail of what went where.
--
-- `document_a_id` < `document_b_id` while both exist. Both are nullable with
-- ON DELETE SET NULL on purpose: the merge deletes the loser, and the row has
-- to outlive that deletion to say which document it was merged into.
CREATE TABLE "document_duplicate_candidates" (
  "id" serial PRIMARY KEY,
  "document_a_id" integer REFERENCES "documents"("id") ON DELETE SET NULL,
  "document_b_id" integer REFERENCES "documents"("id") ON DELETE SET NULL,
  -- Trigram Jaccard of the normalised texts, 0..1.
  "score" real NOT NULL,
  -- What the scan saw: page counts, matching date/correspondent, text sources,
  -- embedding hit, speaking-name shape of a filename.
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 'open' | 'merged' | 'dismissed'
  "status" text NOT NULL DEFAULT 'open',
  -- Set on merge: the document that stayed.
  "keeper_id" integer REFERENCES "documents"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "decided_at" timestamp with time zone
);
CREATE UNIQUE INDEX "document_duplicate_candidates_pair_idx"
  ON "document_duplicate_candidates" ("document_a_id", "document_b_id");
CREATE INDEX "document_duplicate_candidates_status_idx"
  ON "document_duplicate_candidates" ("status");
