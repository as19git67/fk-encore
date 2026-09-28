-- A leg that is the journey between two others (§22.7).
--
-- Until now every leg was a place the group stays at, and the journey
-- between two of them had no home: its departure was a fixpoint on the
-- last day of one leg, its arrival the late start of the next, and the
-- calendar put the two on different days. A transit leg is the journey
-- itself — from the previous leg's base to the next one's, with a
-- beginning and an end that each have a date *and* a time, so it can
-- last two hours or three days.
--
-- `kind` is 'stay' for every leg that exists. For a transit leg:
--   origin_*        where it starts — the previous leg's base; the leg's
--                   own anchor is where it ends
--   depart_minutes  when it sets off, on its first day
--   end_minutes     when it arrives, on its last day
ALTER TABLE trip_plan_legs ADD COLUMN kind text NOT NULL DEFAULT 'stay';--> statement-breakpoint
ALTER TABLE trip_plan_legs ADD COLUMN origin_lat double precision;--> statement-breakpoint
ALTER TABLE trip_plan_legs ADD COLUMN origin_lon double precision;--> statement-breakpoint
ALTER TABLE trip_plan_legs ADD COLUMN origin_label text;--> statement-breakpoint
ALTER TABLE trip_plan_legs ADD COLUMN depart_minutes integer;--> statement-breakpoint
ALTER TABLE trip_plan_legs ADD COLUMN end_minutes integer;
