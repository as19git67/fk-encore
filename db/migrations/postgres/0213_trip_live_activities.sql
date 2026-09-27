-- Live Activities the server keeps current (§8.5 of the trip concept).
--
-- Out of the first trial: the Lock Screen said "Mittag bis 14:00" at
-- dinner. The phone computes the Activity itself, and a phone lying
-- still in a pocket is never woken to compute it again. Apple lets a
-- server update an Activity by push, addressed by a token the Activity
-- itself hands out — one per Activity, not per device, and new each day
-- the app starts one.
--
-- `time_zone` is the phone's (an IANA name): the server has to know
-- which block the day is in, and the plan's clock is the local one.
-- `last_state` is what was last sent, so a tick that would say the same
-- thing again says nothing. A row goes when the day is over, when Apple
-- says the token is dead, or when the app ends the Activity.
CREATE TABLE IF NOT EXISTS "trip_live_activities" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "plan_id" integer NOT NULL REFERENCES "trip_plans"("id") ON DELETE CASCADE,
  "token" text NOT NULL UNIQUE,
  "environment" text NOT NULL DEFAULT 'production',
  "time_zone" text NOT NULL,
  "last_state" jsonb,
  "last_sent_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "trip_live_activities_plan_idx" ON "trip_live_activities" ("plan_id");
