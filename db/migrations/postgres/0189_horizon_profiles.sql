-- The terrain horizon, kept per place (§7.3).
--
-- The light window assumes a free horizon. In a valley or behind a
-- ridge the sun is gone long before astronomical sunset, and a planner
-- that promises golden light at 19:30 for a viewpoint that has been in
-- shadow since 19:00 is wrong in exactly the unpleasant direction.
--
-- Building the profile costs a few hundred points from a height model,
-- so it is done once per place and shared: the ground does not move,
-- and a profile has no expiry date for the same reason. The grid here
-- is about a hundred metres (`horizon-store.ts`) — fine enough that the
-- ridge is the same ridge, coarse enough that two spots in one square
-- reuse one answer.
--
-- The coordinate is the *place's*, not anybody's: a viewpoint, a church,
-- a square on a list. Like the forecast cache next door, this table
-- cannot become a movement profile even if somebody reads it.
CREATE TABLE IF NOT EXISTS horizon_profiles (
  id serial PRIMARY KEY,
  lat real NOT NULL,
  lon real NOT NULL,
  -- Ground height at the place itself, in metres. Kept because every
  -- angle in the profile is relative to it, and a future sampler with
  -- more bearings should be able to check it against what it measures.
  elevation_m real NOT NULL,
  -- [{ "azimuth": 0, "altitude": 2.4 }, …], clockwise from north.
  -- A bearing whose samples were all missing is simply absent; the
  -- reader interpolates across it rather than inventing a zero.
  profile jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS horizon_profiles_place_key
  ON horizon_profiles (lat, lon);
