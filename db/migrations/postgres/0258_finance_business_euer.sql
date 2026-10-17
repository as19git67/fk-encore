-- EÜR per business (documentation/plans/betriebe-euer.md, stage 2): the
-- user tag that selects a business's bookings, the document category its
-- receipts are classified into, and the lines of the Anlage EÜR as a list
-- of {name, kind, tags, form_line}. The report itself is computed from
-- the year's bookings and the asset register, never stored.
ALTER TABLE "finance_business" ADD COLUMN "booking_tag" text;
--> statement-breakpoint
ALTER TABLE "finance_business" ADD COLUMN "document_category" text;
--> statement-breakpoint
ALTER TABLE "finance_business" ADD COLUMN "euer_lines" jsonb NOT NULL DEFAULT '[]'::jsonb;
