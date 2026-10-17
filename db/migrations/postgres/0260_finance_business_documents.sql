-- Documents of a business (documentation/plans/betriebe-euer.md, stage 4):
-- a lease contract on its parcel, an invoice on its asset, a notice on the
-- business itself. The document stays in the documents module; this is
-- only the link, checked against the caller's document access when made.
CREATE TABLE "finance_business_document" (
  "id" serial PRIMARY KEY,
  "business_id" integer NOT NULL REFERENCES "finance_business"("id") ON DELETE CASCADE,
  "document_id" integer NOT NULL,
  "target_kind" text NOT NULL,
  "target_id" integer,
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "finance_business_document_unique" ON "finance_business_document" ("business_id", "document_id", "target_kind", COALESCE("target_id", 0));
--> statement-breakpoint
CREATE INDEX "finance_business_document_by_document" ON "finance_business_document" ("document_id");
