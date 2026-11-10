-- Why a booked visit has its time (reise-planen-und-unterwegs.md,
-- stage 3): ticket, light, reservation, event or departure. Lives on the
-- fixpoint that holds the time, so the reason and the hour cannot drift
-- apart; null for an appointment without a spot and for older rows.
ALTER TABLE "trip_plan_fixpoints" ADD COLUMN IF NOT EXISTS "pin_reason" text;
