-- Values read off tax evidence, per form field (documentation/plans/
-- steuer-ausfuellhilfe.md, stage 2).
--
-- After classify settles tax_role = 'beleg', the `tax_values` job asks the
-- model which kind of evidence the document is and reads that kind's
-- fields. Every amount must stand in the text; one that does not is kept
-- as 'rejected' with its reason, never dropped. A re-read replaces 'read'
-- and 'rejected' rows and leaves what the user confirmed or corrected.
CREATE TABLE IF NOT EXISTS "document_tax_value" (
  "id" serial PRIMARY KEY,
  "document_id" integer NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "tax_year" integer NOT NULL,
  -- 'self' | 'spouse' | 'joint' | 'child:<subject person id>'
  "owner" text NOT NULL,
  "evidence_kind" text NOT NULL,
  "field_key" text NOT NULL,
  -- Cents for amounts, 0 or 1 for flags.
  "value" bigint NOT NULL,
  -- The number as printed and the line it stands in.
  "printed" text,
  "quote" text,
  "page" integer,
  "status" text NOT NULL DEFAULT 'read' CHECK ("status" IN ('read', 'rejected', 'confirmed', 'corrected')),
  -- Why a value was rejected, or what to check about it.
  "note" text,
  "corrected_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE ("document_id", "field_key", "owner")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_tax_value_year" ON "document_tax_value" ("tax_year");
--> statement-breakpoint
-- One row per document read: which kind it was taken for (NULL when none
-- of the candidate kinds fit), so the backfill does not ask again.
CREATE TABLE IF NOT EXISTS "document_tax_reading" (
  "document_id" integer PRIMARY KEY REFERENCES "documents"("id") ON DELETE CASCADE,
  "evidence_kind" text,
  "read_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TYPE "document_job_service" ADD VALUE IF NOT EXISTS 'tax_values';
