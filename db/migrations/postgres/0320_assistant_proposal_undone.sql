-- A write that ran at once (a note, a line added to one) can be taken back
-- with "Rückgängig" on its card: the proposal then ends as `undone`.
ALTER TABLE "assistant_proposal" DROP CONSTRAINT IF EXISTS "assistant_proposal_status_check";--> statement-breakpoint
ALTER TABLE "assistant_proposal" ADD CONSTRAINT "assistant_proposal_status_check"
  CHECK ("status" IN ('pending', 'executing', 'executed', 'discarded', 'undone'));
