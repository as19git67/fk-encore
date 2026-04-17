-- Migration 0025: Document management module.
--
-- Creates the core tables for the documents/ service (private document
-- archive with AI classification), plus:
--   - a generated `text_tsv` tsvector column for lexical full-text search
--     (German configuration), indexed with GIN;
--   - a `document_embeddings` table using pgvector (vector(768) from
--     multilingual-e5-base) with an HNSW index for semantic search.

CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint

CREATE TYPE document_status AS ENUM ('pending', 'extracting', 'classifying', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE document_job_service AS ENUM ('text_extract', 'classify', 'embed');--> statement-breakpoint
CREATE TYPE document_job_status AS ENUM ('pending', 'processing', 'failed', 'done');--> statement-breakpoint
CREATE TYPE document_suggestion_status AS ENUM ('open', 'accepted', 'rejected');--> statement-breakpoint

CREATE TABLE document_categories (
  id         SERIAL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES document_categories(id) ON DELETE SET NULL,
  icon       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);--> statement-breakpoint

CREATE TABLE documents (
  id                        SERIAL PRIMARY KEY,
  user_id                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256                    TEXT NOT NULL UNIQUE,
  original_filename         TEXT NOT NULL,
  mime_type                 TEXT NOT NULL,
  size_bytes                INTEGER NOT NULL,
  disk_path                 TEXT NOT NULL,
  uploaded_at               TIMESTAMP DEFAULT NOW(),
  status                    document_status NOT NULL DEFAULT 'pending',
  category_id               INTEGER REFERENCES document_categories(id) ON DELETE SET NULL,
  title                     TEXT,
  doc_date                  TEXT,
  sender                    TEXT,
  summary                   TEXT,
  extracted_text            TEXT,
  classification_confidence REAL,
  -- Generated full-text search column. Uses the German dictionary for
  -- stemming; good-enough baseline for mixed de/en documents.
  text_tsv                  TSVECTOR GENERATED ALWAYS AS (
                              to_tsvector(
                                'german',
                                coalesce(title, '') || ' ' ||
                                coalesce(sender, '') || ' ' ||
                                coalesce(extracted_text, '')
                              )
                            ) STORED
);--> statement-breakpoint

CREATE INDEX idx_documents_user_id        ON documents (user_id);--> statement-breakpoint
CREATE INDEX idx_documents_category_id    ON documents (category_id) WHERE category_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX idx_documents_status         ON documents (status);--> statement-breakpoint
CREATE INDEX idx_documents_uploaded_at    ON documents (uploaded_at DESC);--> statement-breakpoint
CREATE INDEX idx_documents_text_tsv       ON documents USING GIN (text_tsv);--> statement-breakpoint

CREATE TABLE document_tags (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT
);--> statement-breakpoint

CREATE TABLE document_tag_links (
  document_id INTEGER NOT NULL REFERENCES documents(id)     ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES document_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
);--> statement-breakpoint

CREATE INDEX idx_document_tag_links_tag_id ON document_tag_links (tag_id);--> statement-breakpoint

CREATE TABLE document_scan_queue (
  id          SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  service     document_job_service NOT NULL,
  status      document_job_status  NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  error_msg   TEXT,
  enqueued_at TIMESTAMP NOT NULL DEFAULT NOW(),
  started_at  TIMESTAMP,
  finished_at TIMESTAMP
);--> statement-breakpoint

-- Dedup: at most one active (pending/processing) job per (document, service).
CREATE UNIQUE INDEX uq_active_document_scan
  ON document_scan_queue (document_id, service)
  WHERE status IN ('pending', 'processing');--> statement-breakpoint

-- Worker FIFO pickup.
CREATE INDEX idx_document_scan_queue_pickup
  ON document_scan_queue (service, enqueued_at ASC)
  WHERE status = 'pending';--> statement-breakpoint

CREATE TABLE document_category_suggestions (
  id                   SERIAL PRIMARY KEY,
  suggested_name       TEXT NOT NULL,
  parent_slug          TEXT,
  example_document_ids INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  rationale            TEXT,
  status               document_suggestion_status NOT NULL DEFAULT 'open',
  created_at           TIMESTAMP DEFAULT NOW()
);--> statement-breakpoint

CREATE INDEX idx_document_category_suggestions_status
  ON document_category_suggestions (status);--> statement-breakpoint

-- Semantic embeddings — one row per text chunk per document.
-- vector(768) matches intfloat/multilingual-e5-base.
CREATE TABLE document_embeddings (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_idx   INTEGER NOT NULL,
  chunk_text  TEXT    NOT NULL,
  embedding   VECTOR(768) NOT NULL,
  PRIMARY KEY (document_id, chunk_idx)
);--> statement-breakpoint

-- HNSW index tuned for cosine similarity; pgvector operator class vector_cosine_ops.
CREATE INDEX idx_document_embeddings_hnsw
  ON document_embeddings
  USING hnsw (embedding vector_cosine_ops);
