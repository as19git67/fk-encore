-- Assistant, stage 4 of documentation/plans/assistent-wegfindung.md: the
-- summary of a turn, written by the model after the answer. Later turns
-- replay an older turn as its question and this summary instead of the
-- tool rounds with their results, so the conversation keeps its substance
-- when the window runs short. NULL until the model has written one, or for
-- a turn without tool calls; the answer rows carry it.
ALTER TABLE "assistant_message" ADD COLUMN IF NOT EXISTS "summary" text;
