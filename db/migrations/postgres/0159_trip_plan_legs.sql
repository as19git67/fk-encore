-- Trip planner: the leg, the level between the trip and the day.
--
-- "20 Tage Tokio, Osaka und Hakata" is not one place (§4.2). A leg has its own
-- period, its own anchor, its own way of getting around, its own region
-- database — and therefore its own pool. Redistribution stays inside a leg:
-- what falls out in Tokyo does not slide to Osaka.
--
-- The anchor may be a *zone* rather than an address. Before a hotel is booked,
-- "at most five metro stops from the main square" is all anyone knows;
-- anchor_radius_m records that the anchor is a centroid with a tolerance, so
-- the planner can say so instead of pretending to a street address.
--
-- Days and the pool move from the plan to the leg. Every existing plan becomes
-- a single-leg plan carrying the anchor and region it already had, which is
-- exactly what a one-city trip is; the now-duplicated columns are dropped from
-- trip_plans afterwards.
--
-- See docs/ios-urlaubsplanung.md §4.2.

CREATE TABLE IF NOT EXISTS trip_plan_legs (
  id              serial PRIMARY KEY,
  plan_id         integer NOT NULL REFERENCES trip_plans(id) ON DELETE CASCADE,
  -- 0-based order along the trip.
  position        integer NOT NULL,
  title           text,
  -- Where each day of this leg starts and the last block returns to.
  anchor_lat      double precision NOT NULL,
  anchor_lon      double precision NOT NULL,
  -- Set when the anchor is a zone, not an address: the anchor is its
  -- centroid and this is how far the real base may sit from it.
  anchor_radius_m integer,
  -- foot | bike | transit | car. Belongs to the leg, not the trip: arriving
  -- by car does not mean driving around the old town.
  mode            text NOT NULL DEFAULT 'foot',
  -- Which geo region database this leg's candidates come from.
  region_db       text NOT NULL,
  -- Optional real dates. Absent means "day 1, day 2, …" as before.
  start_date      date,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_legs_plan_position_key
  ON trip_plan_legs (plan_id, position);

-- One leg per existing plan, carrying what the plan itself held.
INSERT INTO trip_plan_legs (plan_id, position, title, anchor_lat, anchor_lon, region_db)
SELECT id, 0, title, anchor_lat, anchor_lon, region_db FROM trip_plans;

-- Days hang off the leg from here on.
ALTER TABLE trip_plan_days ADD COLUMN IF NOT EXISTS leg_id integer
  REFERENCES trip_plan_legs(id) ON DELETE CASCADE;

UPDATE trip_plan_days d
   SET leg_id = l.id
  FROM trip_plan_legs l
 WHERE l.plan_id = d.plan_id AND l.position = 0;

ALTER TABLE trip_plan_days ALTER COLUMN leg_id SET NOT NULL;

DROP INDEX IF EXISTS trip_plan_days_plan_index_key;
ALTER TABLE trip_plan_days DROP COLUMN IF EXISTS plan_id;

-- day_index is now relative to the leg: each leg counts its own days from 0.
CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_days_leg_index_key
  ON trip_plan_days (leg_id, day_index);

-- The pool is per leg, because the candidates come from the leg's region.
ALTER TABLE trip_plan_pool ADD COLUMN IF NOT EXISTS leg_id integer
  REFERENCES trip_plan_legs(id) ON DELETE CASCADE;

UPDATE trip_plan_pool p
   SET leg_id = l.id
  FROM trip_plan_legs l
 WHERE l.plan_id = p.plan_id AND l.position = 0;

ALTER TABLE trip_plan_pool ALTER COLUMN leg_id SET NOT NULL;

DROP INDEX IF EXISTS trip_plan_pool_plan_ref_key;
ALTER TABLE trip_plan_pool DROP COLUMN IF EXISTS plan_id;

CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_pool_leg_ref_key
  ON trip_plan_pool (leg_id, osm_ref);

-- The anchor and the region belong to the leg now.
ALTER TABLE trip_plans DROP COLUMN IF EXISTS anchor_lat;
ALTER TABLE trip_plans DROP COLUMN IF EXISTS anchor_lon;
ALTER TABLE trip_plans DROP COLUMN IF EXISTS region_db;
