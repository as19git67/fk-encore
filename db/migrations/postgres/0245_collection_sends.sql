-- Sending a collection's export (issue #1548, stage 7).
--
-- A run can carry a download link for people without an account: a random
-- token, valid until the file itself expires. A mail too large for
-- attachments carries that link instead.
ALTER TABLE "collection_exports" ADD COLUMN "download_token" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "collection_exports_download_token" ON "collection_exports" ("download_token") WHERE "download_token" IS NOT NULL;
--> statement-breakpoint
-- Every mail sent from the server is logged with the collection: when, by
-- whom, to whom, and how the export travelled.
CREATE TABLE "collection_sends" (
  "id" serial PRIMARY KEY,
  "collection_id" integer NOT NULL REFERENCES "document_collections"("id") ON DELETE CASCADE,
  "export_id" integer REFERENCES "collection_exports"("id") ON DELETE SET NULL,
  "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "recipients" text[] NOT NULL,
  "mode" text NOT NULL,
  "filename" text,
  "status" text NOT NULL,
  "error" text,
  "sent_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "collection_sends_by_collection" ON "collection_sends" ("collection_id", "sent_at" DESC);
