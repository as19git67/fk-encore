-- Who is actually coming (§3.5).
--
-- "Wir" is not generic: two children under ten make a different day
-- from two adults, and the planner has always been able to act on that
-- — blocks.ts shrinks every block's budget for `withChildren` and again
-- for `limitedMobility`. What was missing is where those two flags come
-- from. They came out of a sentence somebody typed, which is right on
-- the first trip and stale on the next: a child who was eight when the
-- trip was described is eleven two years later, and nothing noticed.
--
-- This table holds the people instead, so the flags can be derived
-- fresh for the date the trip starts. Most of them are already in the
-- house as `user_subject_persons` (relationship, and for most a birth
-- date), which is why the common case is a reference rather than a
-- copy: the birth date is read from there and stays right when it is
-- corrected there.
--
-- `label` exists because not everybody on a trip is in that table — a
-- friend's child, a grandmother who has no paperwork here. Such a row
-- carries its own name and, if given, its own birth date.
--
-- `short_walks` is set by a person and never derived. Age says how long
-- a small child lasts, which is a fact about small children; "needs
-- shorter distances" is a statement about somebody, and a planner that
-- concluded it from a birth year would be both wrong and rude.
CREATE TABLE IF NOT EXISTS trip_plan_travellers (
  id serial PRIMARY KEY,
  plan_id integer NOT NULL REFERENCES trip_plans(id) ON DELETE CASCADE,
  -- The household entry this traveller is, when they are one of them.
  -- ON DELETE SET NULL rather than CASCADE: removing somebody from the
  -- household should not silently shrink a trip they are on.
  subject_person_id integer REFERENCES user_subject_persons(id) ON DELETE SET NULL,
  -- What the trip calls them. Filled from the household entry when
  -- there is one, so a row is readable even after that link is gone.
  label text NOT NULL,
  -- Only for travellers who are not a household entry; otherwise the
  -- date is read from user_subject_persons, where corrections land.
  birth_date text,
  short_walks boolean NOT NULL DEFAULT false,
  added_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trip_plan_travellers_plan_idx
  ON trip_plan_travellers (plan_id);
-- The same household member added twice is the same statement twice.
-- Partial, because several travellers may have no household entry.
CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_travellers_plan_person_key
  ON trip_plan_travellers (plan_id, subject_person_id)
  WHERE subject_person_id IS NOT NULL;
