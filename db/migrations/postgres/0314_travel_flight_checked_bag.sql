-- Flight watches: only report a price with one checked bag per seated
-- traveller (on by default). Google Flights cannot filter for checked bags,
-- so the bag fee comes from the booking options of the reported flight
-- (documentation/plans/reise-flugpreise.md, "Checked bag").
ALTER TABLE travel_flight_watch ADD COLUMN IF NOT EXISTS checked_bag BOOLEAN NOT NULL DEFAULT TRUE;
--> statement-breakpoint
ALTER TABLE travel_flight_check ADD COLUMN IF NOT EXISTS bag_price DOUBLE PRECISION;
--> statement-breakpoint
ALTER TABLE travel_flight_booking ADD COLUMN IF NOT EXISTS baggage TEXT NOT NULL DEFAULT '';
