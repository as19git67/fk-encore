-- Trip planner: where a candidate came from (§9.2).
--
-- The planner proposes candidates, but your own research is the second and at
-- least as important source. A find has to compete in the pool like any other
-- candidate — and to do that honestly, the pool has to be able to say where an
-- entry came from.
--
-- Why a spot was saved ("beste Pastéis laut Blog") matters more when planning
-- than its name does, and who contributed it belongs visibly next to it (§6.1).
-- So: the note, the link it came from, and the person.
--
-- `origin` separates a candidate the region search produced from one a person
-- put there. The distinction is not cosmetic: a manual find may have no OSM
-- entry behind it, which means no opening hours and no category — and §9.2 is
-- emphatic that missing data is named rather than guessed.

ALTER TABLE trip_plan_pool
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'search';

ALTER TABLE trip_plan_pool
  ADD COLUMN IF NOT EXISTS note text;

ALTER TABLE trip_plan_pool
  ADD COLUMN IF NOT EXISTS source_url text;

ALTER TABLE trip_plan_pool
  ADD COLUMN IF NOT EXISTS added_by integer REFERENCES users(id) ON DELETE SET NULL;

-- True when no OSM entry could be matched. Opening hours and category are then
-- unknown, and the planner says so instead of reckoning with invented values.
ALTER TABLE trip_plan_pool
  ADD COLUMN IF NOT EXISTS unmatched boolean NOT NULL DEFAULT false;
