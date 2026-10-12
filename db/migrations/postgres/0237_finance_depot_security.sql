-- The securities master of a depot (.claude/plans/wertpapier-stamm.md).
--
-- A security is booked into a depot only once it is confirmed there. What
-- the bank's holdings deliver is confirmed by itself; a security met only
-- in a booking's text or a paper is proposed, with the evidence, until the
-- user takes it in or ignores it.
CREATE TABLE "finance_depot_security" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "account_id" integer NOT NULL REFERENCES "finance_account"("id") ON DELETE CASCADE,
  "isin" text,
  "wkn" text,
  "name" text,
  "status" text NOT NULL DEFAULT 'proposed',
  "source" text NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone,
  "decided_by" integer REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "finance_depot_security_isin" ON "finance_depot_security" USING btree ("account_id","isin") WHERE "isin" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "finance_depot_security_wkn" ON "finance_depot_security" USING btree ("account_id","wkn") WHERE "wkn" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "finance_depot_security_evidence" (
  "security_id" bigint NOT NULL REFERENCES "finance_depot_security"("id") ON DELETE CASCADE,
  "transaction_id" bigint REFERENCES "finance_transaction"("id") ON DELETE CASCADE,
  "document_id" integer REFERENCES "documents"("id") ON DELETE CASCADE,
  "seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "finance_depot_security_evidence_tx" ON "finance_depot_security_evidence" USING btree ("security_id","transaction_id") WHERE "transaction_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "finance_depot_security_evidence_doc" ON "finance_depot_security_evidence" USING btree ("security_id","document_id") WHERE "document_id" IS NOT NULL;
--> statement-breakpoint
-- What the depots hold today is confirmed from the start.
INSERT INTO "finance_depot_security" ("account_id", "isin", "wkn", "name", "status", "source", "decided_at")
SELECT DISTINCT ON (h."account_id", COALESCE(h."isin", h."wkn"))
  h."account_id", h."isin", h."wkn", h."name", 'confirmed', 'bank', now()
FROM "finance_account_holding" h
WHERE h."isin" IS NOT NULL OR h."wkn" IS NOT NULL
ORDER BY h."account_id", COALESCE(h."isin", h."wkn"), h."as_of" DESC
ON CONFLICT DO NOTHING;
