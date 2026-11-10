-- One short German sentence per place for the spot picker and the day
-- cards, made from its description (`trip-planner/spot-summary.ts`),
-- with the key of the text it was made from.
ALTER TABLE "trip_spot_fame" ADD COLUMN IF NOT EXISTS "summary" jsonb;
