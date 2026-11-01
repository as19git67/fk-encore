-- The assistant waits for a card instead of giving up on the step after it:
-- what it will do once the user pressed "Ausführen" (the rest of the
-- question that needs the card's result). The app asks the assistant to go
-- on with it as soon as the card ran.
ALTER TABLE "assistant_proposal" ADD COLUMN IF NOT EXISTS "continuation" text;
