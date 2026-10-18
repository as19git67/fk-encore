-- Tax relevance as a role (documentation/plans/steuer-belegrolle.md, stage 1):
-- 'beleg' is the evidence filed with the return (what tax_relevant = true
-- meant so far), 'bezug' concerns a tax matter and keeps its sections but
-- never counts, 'keine' has no tax relation. tax_relevant stays and is
-- derived from the role (beleg) by every writer.
ALTER TABLE "documents" ADD COLUMN "tax_role" text NOT NULL DEFAULT 'keine';
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tax_role_check" CHECK ("tax_role" IN ('beleg', 'bezug', 'keine'));
--> statement-breakpoint
UPDATE "documents" SET "tax_role" = 'beleg' WHERE "tax_relevant" = true;
--> statement-breakpoint
CREATE INDEX "documents_tax_role_idx" ON "documents" ("tax_role");
