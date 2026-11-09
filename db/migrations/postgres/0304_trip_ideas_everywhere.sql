-- Every trip becomes a trip of ideas (reise-planen-und-unterwegs.md,
-- stage 1). Kept: stays, journeys, days, fixpoints, breaks, planned
-- stops, and every pool row somebody brought in (a find, a share, a
-- manual add) — those are the trip's ideas. Dropped: what the old
-- region search put in the pool, routes ("Strecken"), votes, and the
-- model's ordering of the searched candidates.

UPDATE trip_plans
SET constraints = constraints || '{"ideas": true, "voting": false}'::jsonb
WHERE NOT (constraints ? 'ideas') OR constraints->'ideas' <> 'true'::jsonb;
--> statement-breakpoint
DELETE FROM trip_plan_pool WHERE origin = 'search';
--> statement-breakpoint
DELETE FROM trip_plan_pool WHERE category = 'route';
--> statement-breakpoint
DELETE FROM trip_plan_stops WHERE category = 'route';
--> statement-breakpoint
DELETE FROM trip_plan_votes;
--> statement-breakpoint
DELETE FROM trip_leg_curation;
