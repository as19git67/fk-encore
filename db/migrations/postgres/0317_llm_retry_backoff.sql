-- Background jobs that ask the local model retried an unusable answer on
-- every tick. These columns let them count failures and wait between tries.

-- A paper whose settlement the model could not read usefully (cut off,
-- not JSON): the hourly retry leaves it alone after three tries.
CREATE TABLE IF NOT EXISTS "finance_document_settlement_llm_failure" (
  "document_id" integer PRIMARY KEY REFERENCES "documents"("id") ON DELETE CASCADE,
  "failures" integer NOT NULL DEFAULT 0,
  "error" text,
  "failed_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- A collection summary that failed: tried again an hour later, three times.
ALTER TABLE "document_collections" ADD COLUMN IF NOT EXISTS "summary_failures" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "document_collections" ADD COLUMN IF NOT EXISTS "summary_failed_at" timestamp with time zone;
