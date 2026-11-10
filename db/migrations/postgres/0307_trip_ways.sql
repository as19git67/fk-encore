-- Ways between the spots of a day (reise-planen-und-unterwegs.md,
-- stage 6).
--
-- trip_route_cache: what the router answered for one pair of points and
-- one mode, so a day map fetches only the segments a reorder made new.
-- Keyed by the two ends rounded to about a metre and the mode.
CREATE TABLE IF NOT EXISTS "trip_route_cache" (
  "key" text PRIMARY KEY NOT NULL,
  "mode" text NOT NULL,
  "minutes" integer NOT NULL,
  "distance_m" integer NOT NULL,
  "shape" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- trip_plan_segments: a mode somebody picked in "Weg" for one segment,
-- from one spot (or the start of the day) to the next. It holds only
-- while the two stand next to each other; the day times use its
-- minutes instead of the estimate.
CREATE TABLE IF NOT EXISTS "trip_plan_segments" (
  "id" serial PRIMARY KEY NOT NULL,
  "plan_id" integer NOT NULL REFERENCES "trip_plans"("id") ON DELETE CASCADE,
  "from_ref" text NOT NULL,
  "to_ref" text NOT NULL,
  "mode" text NOT NULL,
  "minutes" integer NOT NULL,
  "distance_m" integer NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "trip_plan_segments_pair_key"
  ON "trip_plan_segments" ("plan_id", "from_ref", "to_ref");
