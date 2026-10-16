-- Follow-up questions within an assistant conversation
-- (documentation/plans/ki-assistent.md, stage 5, issue #1530).
--
-- A tool row keeps the one-line digest of its result, so a later turn can
-- replay what an earlier answer was based on without the whole result, and
-- the ids of the set it found, so "mach daraus ein Album" or "nur die aus
-- München" works on that set instead of searching again.
ALTER TABLE "assistant_message" ADD COLUMN "digest" text;
--> statement-breakpoint
ALTER TABLE "assistant_message" ADD COLUMN "result_ref" jsonb;
