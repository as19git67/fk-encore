-- Where the trip starts from and returns to (§22.7).
--
-- The journey to the first place and the journey home are journeys
-- like the ones between two places, and the corridor along them is
-- worth the same look: what lies on the way there is what a family
-- stops at on the way. A journey needs two ends, and until now the
-- trip knew only its places. Null while nobody said where home is.
ALTER TABLE trip_plans ADD COLUMN home_lat double precision;--> statement-breakpoint
ALTER TABLE trip_plans ADD COLUMN home_lon double precision;--> statement-breakpoint
ALTER TABLE trip_plans ADD COLUMN home_label text;
