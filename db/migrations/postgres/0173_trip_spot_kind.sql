-- What OpenStreetMap calls the place (§7.2).
--
-- The planner's own category is coarse on purpose — "sight" holds
-- cathedrals and market squares alike — and that is exactly the
-- distinction indoor/outdoor turns on: a downpour is a reason to move
-- the market square and no reason at all to move the cathedral.
-- `kind` is the tag a mapper actually wrote (`tourism=museum`,
-- `building=church`, `historic=ruins`), carried onto the stop and the
-- pool entry so the derivation needs no lookup back into the region
-- database.
--
-- Nullable: a find brought in by hand has no OSM entry behind it, and
-- guessing a tag for it would be inventing data (§9.2, §15.3).
ALTER TABLE trip_plan_stops ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE trip_plan_pool ADD COLUMN IF NOT EXISTS kind text;
