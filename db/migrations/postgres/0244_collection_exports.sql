-- Exports of a collection, of any type (issue #1548, stage 6).
--
-- A profile is a named set of export options kept with the collection, so the
-- same choice drives a download today and, later, sending, the share link and
-- the scheduled export.
CREATE TABLE "collection_export_profiles" (
  "id" serial PRIMARY KEY,
  "collection_id" integer NOT NULL REFERENCES "document_collections"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "options" jsonb NOT NULL,
  "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "collection_export_profiles_name" ON "collection_export_profiles" ("collection_id", lower("name"));
--> statement-breakpoint
-- One row per export run and reader: the reader matters because a group
-- collection leaves out what that reader may not open. The file lives on disk
-- until `expires_at`.
CREATE TABLE "collection_exports" (
  "id" serial PRIMARY KEY,
  "collection_id" integer NOT NULL REFERENCES "document_collections"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "profile_id" integer REFERENCES "collection_export_profiles"("id") ON DELETE SET NULL,
  "options" jsonb NOT NULL,
  "status" text NOT NULL,
  "filename" text,
  "mime_type" text,
  "size_bytes" bigint,
  "item_count" integer NOT NULL DEFAULT 0,
  "skipped" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "error" text,
  "document_id" integer REFERENCES "documents"("id") ON DELETE SET NULL,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finished_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "collection_exports_by_reader" ON "collection_exports" ("collection_id", "user_id", "started_at" DESC);
