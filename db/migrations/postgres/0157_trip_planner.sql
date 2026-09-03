-- Trip planner: the persisted form of a plan.
--
-- A plan holds days, each an ordered list of blocks, each an ordered list of
-- stops — plus the pool of scored candidates that did not make it in.
--
-- The pool is not a leftovers bin. Redistribution moves displaced stops back
-- into it and pulls replacements out of it, so it is the working set the whole
-- "we are here, it is now" mechanic turns on. `priority_boost` is what keeps a
-- displaced stop from sinking in the ranking: it comes back first on a
-- following day rather than competing from scratch.
--
-- See docs/ios-urlaubsplanung.md §5 and §12.

CREATE TABLE IF NOT EXISTS trip_plans (
  id          serial PRIMARY KEY,
  owner_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text,
  -- The leg's anchor: where each day starts and the last block returns to.
  anchor_lat  double precision NOT NULL,
  anchor_lon  double precision NOT NULL,
  region_db   text NOT NULL,
  -- The request that produced this plan, kept so a replan can reuse it.
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trip_plans_owner_idx ON trip_plans (owner_id);

CREATE TABLE IF NOT EXISTS trip_plan_days (
  id        serial PRIMARY KEY,
  plan_id   integer NOT NULL REFERENCES trip_plans(id) ON DELETE CASCADE,
  -- 0-based position in the plan; real dates arrive with legs.
  day_index integer NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_days_plan_index_key
  ON trip_plan_days (plan_id, day_index);

CREATE TABLE IF NOT EXISTS trip_plan_blocks (
  id             serial PRIMARY KEY,
  day_id         integer NOT NULL REFERENCES trip_plan_days(id) ON DELETE CASCADE,
  position       integer NOT NULL,
  -- A block is a label plus a budget, not a fixed enumeration: the template id
  -- and label travel with the row so a custom day needs no new type.
  template_id    text NOT NULL,
  label          text NOT NULL,
  kind           text NOT NULL,
  budget_minutes integer NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_blocks_day_position_key
  ON trip_plan_blocks (day_id, position);

CREATE TABLE IF NOT EXISTS trip_plan_stops (
  id                serial PRIMARY KEY,
  block_id          integer NOT NULL REFERENCES trip_plan_blocks(id) ON DELETE CASCADE,
  position          integer NOT NULL,
  osm_ref           text NOT NULL,
  name              text,
  lat               double precision NOT NULL,
  lon               double precision NOT NULL,
  category          text NOT NULL,
  dwell_minutes     integer NOT NULL,
  -- The walk from the previous position, as shown on the block card.
  travel_minutes    integer NOT NULL DEFAULT 0,
  travel_distance_m integer NOT NULL DEFAULT 0,
  -- planned | done | skipped. Anything not `planned` is past and is never
  -- moved by a redistribution.
  status            text NOT NULL DEFAULT 'planned',
  -- Pinned stops are fixed points: kept where they are, whatever else moves.
  pinned            boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_stops_block_position_key
  ON trip_plan_stops (block_id, position);
CREATE INDEX IF NOT EXISTS trip_plan_stops_block_idx ON trip_plan_stops (block_id);

CREATE TABLE IF NOT EXISTS trip_plan_pool (
  id             serial PRIMARY KEY,
  plan_id        integer NOT NULL REFERENCES trip_plans(id) ON DELETE CASCADE,
  osm_ref        text NOT NULL,
  name           text,
  lat            double precision NOT NULL,
  lon            double precision NOT NULL,
  category       text NOT NULL,
  dwell_minutes  integer NOT NULL,
  score          real NOT NULL,
  reasons        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Raised when a stop was displaced, so it returns first rather than
  -- competing from scratch on the next day.
  priority_boost real NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_pool_plan_ref_key
  ON trip_plan_pool (plan_id, osm_ref);
