-- The pool without a trip (§20).
--
-- Everything until now needs a trip: you create one, name a place, get
-- days. That is the half people *plan*, and the rarer one. The commoner
-- half is what they *collect* — the beer garden somebody mentioned, the
-- exhibition in the next town, the walk that came up twice. Things
-- without a date, without a city, without a frame.
--
-- The building block has existed all along: the pool (§5) is a scored
-- list of possibilities. It merely hangs off a leg. These tables are
-- the same list without one.
--
-- Columns mirror `trip_plan_pool` on purpose, minus `leg_id` and plus
-- three things a standing collection needs: who put it there (§20.1 —
-- "Papa wollte da hin" is half the information), an optional validity
-- window for something that ends (§20.4), and the bookkeeping that
-- makes "told you once" durable (§20.5): when it was last suggested and
-- how often it was waved away. Suggesting the same beer garden twice a
-- week is nagging (§6.4).
CREATE TABLE IF NOT EXISTS idea_pool (
  id serial PRIMARY KEY,
  -- Whose collection this is. Sharing is a row in idea_pool_shares, the
  -- same shape §6.2 uses for a trip: one list people write into, not a
  -- copy per person.
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  osm_ref text NOT NULL,
  name text,
  -- What the family calls it, when that is not what the map calls it.
  title text,
  local_name text,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  category text NOT NULL,
  kind text,
  dwell_minutes integer NOT NULL,
  note text,
  source_url text,
  wikipedia_url text,
  facade_azimuth real,
  -- True when no OpenStreetMap entry matched: category and duration are
  -- guesses, and the app says so rather than presenting them as data.
  unmatched boolean NOT NULL DEFAULT false,
  photo_stop boolean NOT NULL DEFAULT false,
  -- Something that ends: an exhibition until Sunday (§20.4). Both null
  -- for the ordinary case, a place that is simply there.
  valid_from date,
  valid_to date,
  -- The nearness rule (§20.5): remembered rather than deleted, so a
  -- "not now" is not re-offered tomorrow.
  last_suggested_at timestamptz,
  dismissed_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One entry per place per collection: the same beer garden mentioned
-- twice is one idea, and the second mention merges into the first.
CREATE UNIQUE INDEX IF NOT EXISTS idea_pool_owner_ref_key
  ON idea_pool (owner_id, osm_ref);
CREATE INDEX IF NOT EXISTS idea_pool_owner_idx ON idea_pool (owner_id);

-- Who else writes into this collection. Deliberately the same shape as
-- trip_plan_shares — a household is a list of people, not a permission
-- grid (§6.2).
CREATE TABLE IF NOT EXISTS idea_pool_shares (
  id serial PRIMARY KEY,
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idea_pool_shares_owner_user_key
  ON idea_pool_shares (owner_id, user_id);
CREATE INDEX IF NOT EXISTS idea_pool_shares_user_idx ON idea_pool_shares (user_id);
