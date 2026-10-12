-- Depot statements as holdings (.claude/plans/wertpapier-stamm.md, stage 2).
--
-- A holdings row so far always came from the bank (FinTS). A depot
-- statement or a reporting says what the depot held on a day as well; its
-- rows carry source 'document' and the document they were read from, so
-- they can be told apart, listed with the paper and removed with it.
ALTER TABLE "finance_account_holding" ADD COLUMN "source" text NOT NULL DEFAULT 'bank';
--> statement-breakpoint
ALTER TABLE "finance_account_holding" ADD COLUMN "document_id" integer REFERENCES "documents"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "finance_account_holding_document_idx" ON "finance_account_holding" USING btree ("document_id") WHERE "document_id" IS NOT NULL;
--> statement-breakpoint
-- What the model answered about a statement's positions, kept so it is asked once.
CREATE TABLE "finance_document_statement_llm" (
  "document_id" integer PRIMARY KEY NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "values" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
