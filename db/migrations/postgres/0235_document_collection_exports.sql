-- The PDF of a Sammelmappe is built in the background and kept (one per
-- collection and reader): leaving the page no longer cancels the build, and
-- coming back offers the file that is already there. The bytes live under
-- DOCUMENTS_DIR/_collections; this row tracks the build and the inputs it was
-- made from (`fingerprint`), so a folder changed since can say so.
CREATE TABLE "document_collection_exports" (
  "collection_id" integer NOT NULL REFERENCES "document_collections"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "fingerprint" text,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finished_at" timestamp with time zone,
  "error" text,
  "filename" text,
  "page_count" integer,
  "size_bytes" integer,
  "skipped" jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY ("collection_id", "user_id")
);
