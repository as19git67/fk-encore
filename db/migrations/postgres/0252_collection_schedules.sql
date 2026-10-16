-- Scheduled exports of a collection (issue #1548, stage 9).
--
-- A schedule runs an export weekly, monthly or yearly as the person who set
-- it up, of the whole collection or only of what is dated in the elapsed
-- period, and keeps the file, files a PDF as a document and/or mails it.
CREATE TABLE "collection_schedules" (
  "id" serial PRIMARY KEY,
  "collection_id" integer NOT NULL REFERENCES "document_collections"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "profile_id" integer REFERENCES "collection_export_profiles"("id") ON DELETE SET NULL,
  "options" jsonb NOT NULL,
  "cadence" text NOT NULL,
  "weekday" integer,
  "day" integer,
  "month" integer,
  "scope" text NOT NULL,
  "save_as_document" boolean NOT NULL DEFAULT false,
  "recipients" text[] NOT NULL DEFAULT '{}',
  "single_files" boolean NOT NULL DEFAULT false,
  "message" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "next_run_at" timestamp with time zone NOT NULL,
  "last_run_at" timestamp with time zone,
  "last_status" text,
  "last_error" text,
  "last_export_id" integer REFERENCES "collection_exports"("id") ON DELETE SET NULL,
  "failures" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "collection_schedules_due" ON "collection_schedules" ("next_run_at") WHERE "enabled";
