-- Model-first reading (documentation/plans/wertpapier-stamm.md, stage 3).
--
-- A paper with a security identifier whose wording neither the settlement
-- nor the statement rules recognise is shown to the model once: which kind
-- of paper is it? The answer routes it to the settlement or the statement
-- reader, or leaves it alone ("other"), and is kept so it is asked once.
CREATE TABLE "finance_document_paper_llm" (
  "document_id" integer PRIMARY KEY NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "paper_type" text NOT NULL,
  "values" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "finance_document_paper_llm_type_idx" ON "finance_document_paper_llm" USING btree ("paper_type");
