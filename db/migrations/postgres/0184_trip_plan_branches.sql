-- Splits: apart for an afternoon, planned together (§6.5).
--
-- One into the technical museum, the others to the market; a parent
-- stays at the hotel with the sleeping child. §6.5 is emphatic about
-- the shape this takes: **a split is an attribute of a block, not a
-- second trip.** A block gets two or more branches instead of one
-- sequence of stops, each with its own people, its own order and its
-- own budget. They all start where the group separates and end at the
-- meeting point — which is a real fixpoint with a clock time in the
-- sense of §4.4. From the meeting point backwards each branch's budget
-- follows, and the existing solver simply runs n times. No further
-- machinery is needed, and this table is the reason why.
--
-- The limit is deliberate and lives in the service: a split runs inside
-- one block, at most across one day. Separating for three days is two
-- trips, and needs no special logic.
CREATE TABLE IF NOT EXISTS trip_plan_branches (
  id serial PRIMARY KEY,
  block_id integer NOT NULL REFERENCES trip_plan_blocks(id) ON DELETE CASCADE,
  position integer NOT NULL,
  -- "Ins Technikmuseum", "Auf den Markt" — what this branch is doing.
  label text NOT NULL,
  -- Where and when everybody is back together. The time is minutes
  -- past midnight, like every other clock in the planner (§4.4).
  meeting_label text,
  meeting_lat double precision,
  meeting_lon double precision,
  meeting_minutes integer NOT NULL,
  -- What the branch had to spend, computed backwards from the meeting
  -- point. Stored rather than recomputed so the card can show it
  -- without re-deriving the whole day.
  budget_minutes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (block_id, position)
);

CREATE INDEX IF NOT EXISTS trip_plan_branches_block_idx
  ON trip_plan_branches (block_id);

-- Who walks in which branch. Exactly one of the two columns is set —
-- an account, or somebody travelling without one (§3.5, §6.1), the
-- same two kinds of person the votes know.
CREATE TABLE IF NOT EXISTS trip_plan_branch_members (
  id serial PRIMARY KEY,
  branch_id integer NOT NULL REFERENCES trip_plan_branches(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  traveller_id integer REFERENCES trip_plan_travellers(id) ON DELETE CASCADE,
  CONSTRAINT trip_plan_branch_members_one_person CHECK (
    (user_id IS NOT NULL AND traveller_id IS NULL)
    OR (user_id IS NULL AND traveller_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS trip_plan_branch_members_branch_idx
  ON trip_plan_branch_members (branch_id);

-- Which branch a stop belongs to. NULL is the ordinary case: the whole
-- group is together, which is what every block was until now.
ALTER TABLE trip_plan_stops
  ADD COLUMN IF NOT EXISTS branch_id integer
  REFERENCES trip_plan_branches(id) ON DELETE CASCADE;
