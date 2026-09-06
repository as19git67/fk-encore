-- A leg that is framed but waiting for its map (§4.3, §15.3).
--
-- Typing a city the server has no OpenStreetMap region for saves the
-- trip anyway: the days get their frame — blocks with budgets,
-- fixpoints — and no spots, and the region import is asked for. What
-- was missing is the other half of that promise. Nothing filled the
-- days in once the import landed, because nothing recorded that they
-- were waiting: an empty leg whose region is now ready is
-- indistinguishable from a leg whose search genuinely found nothing,
-- and a worker that could not tell them apart would re-plan the second
-- kind for ever.
--
-- So the leg says it itself. Set when the leg was planned without a
-- region, cleared the moment its days are filled.
ALTER TABLE trip_plan_legs
  ADD COLUMN IF NOT EXISTS awaiting_region boolean NOT NULL DEFAULT false;

-- The worker's whole query: which legs are still waiting?
CREATE INDEX IF NOT EXISTS trip_plan_legs_awaiting_region_idx
  ON trip_plan_legs (plan_id)
  WHERE awaiting_region;
