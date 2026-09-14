-- "Warum hier?" on every planned stop (§8.3).
--
-- The reasons the scoring gave — "hat einen Wikipedia-Artikel", "ihr
-- wolltet: Museen" — lived on the pool row only. Placing a spot
-- deletes that row, so the question mark the day screen promises on
-- every stop appeared on almost none. The reasons now travel with the
-- stop, like its note and its origin already do.
ALTER TABLE trip_plan_stops
  ADD COLUMN reasons JSONB NOT NULL DEFAULT '[]'::jsonb;
