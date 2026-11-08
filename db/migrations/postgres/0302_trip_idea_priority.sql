-- Priority and opening hours of an idea (ideas plan, stage 3). Both on
-- the pool row and on the stop, because placing an idea on a day moves
-- the row: the stop is the idea while it is planned, and a stop that
-- goes back to the ideas takes both with it.
ALTER TABLE trip_plan_pool ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'want';
--> statement-breakpoint
ALTER TABLE trip_plan_pool ADD COLUMN IF NOT EXISTS opening_hours TEXT;
--> statement-breakpoint
ALTER TABLE trip_plan_stops ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'want';
--> statement-breakpoint
ALTER TABLE trip_plan_stops ADD COLUMN IF NOT EXISTS opening_hours TEXT;
