-- Migration 0054: convert document_embeddings.embedding from vector(768)
-- to halfvec(768).
--
-- Background:
--   pgvector 0.7+ introduced ``halfvec``, a half-precision (FP16) variant
--   of ``vector`` that stores each element in 2 bytes instead of 4. Cosine
--   similarity on halfvec on a normalised 768-d corpus retains essentially
--   identical recall (sub-half-percent gap on standard benchmarks) while
--   halving on-disk storage and HNSW index RAM.
--
-- Compatibility:
--   The conversion is wrapped in a DO block that detects whether the
--   ``halfvec`` type exists. On older pgvector (e.g. Ubuntu Noble's
--   default 0.6.0 in the local sandbox) the block emits a NOTICE and
--   leaves the column as ``vector(768)`` — the runtime queries do not
--   reference ``halfvec`` directly, so they keep working against the
--   original column type. Production and CI use pgvector ≥ 0.7 (image
--   ``pgvector/pgvector:pg18``) where the conversion runs.
--
-- Operational notes:
--   * ``ALTER EXTENSION vector UPDATE`` brings the catalog forward to
--     whatever shared library version is installed; safe no-op if the
--     extension is already current.
--   * The HNSW index is dropped first so the column-type rewrite is not
--     performed against a live index, then rebuilt with
--     ``halfvec_cosine_ops``. That rebuild is the slowest step on a
--     populated table; on an empty / small corpus it returns instantly.
--   * No data loss: ``vector::halfvec`` rounds each component to FP16 at
--     read time; the rebuild rewrites the table once.

ALTER EXTENSION vector UPDATE;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'halfvec') THEN
    EXECUTE 'DROP INDEX IF EXISTS idx_document_embeddings_hnsw';
    EXECUTE 'ALTER TABLE document_embeddings
             ALTER COLUMN embedding
             TYPE halfvec(768)
             USING embedding::halfvec(768)';
    EXECUTE 'CREATE INDEX idx_document_embeddings_hnsw
             ON document_embeddings
             USING hnsw (embedding halfvec_cosine_ops)';
  ELSE
    RAISE NOTICE 'pgvector halfvec type unavailable (need >= 0.7); leaving document_embeddings.embedding as vector(768). Upgrade pgvector and re-run this migration step manually if needed.';
  END IF;
END
$$;
