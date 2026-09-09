-- Where a planned spot came from, kept on the stop itself (§9.2).
--
-- The pool row records whether a place was the machine's suggestion or
-- somebody's own find, and that row is deleted the moment the spot is
-- placed on a day. Coming back — displaced by a redistribution, or put
-- back by hand — it was written to the pool as an ordinary search
-- result, with three consequences: the next settings change deleted it
-- (a re-plan keeps only what is not "search"), the app offered "hide"
-- instead of "remove", and the link it arrived with was gone.
--
-- Provenance belongs to the spot, not to the row it happens to sit in.
ALTER TABLE trip_plan_stops
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'search';
