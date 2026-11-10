-- The weather at a visit (reise-planen-und-unterwegs.md, stage 5):
-- temperature, rain and cloud of the hour it began, taken from the
-- cached forecast when the visit is recorded. Null where there was no
-- forecast, and for older rows.
ALTER TABLE "trip_plan_visits" ADD COLUMN IF NOT EXISTS "weather" jsonb;
