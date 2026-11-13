-- Hotel price watches over an area and with flexible dates
-- (documentation/plans/reise-hotelpreise.md, stage 4).
--
-- `kind = 'area'`: `query` is a place; the check reads Google's result list,
-- narrowed by `min_stars` and `min_rating` (Google's 1–5 scale), and the
-- details of the cheapest hits. `flexible`: `check_in`/`check_out` are the
-- earliest arrival and the latest departure, a stay lasts `min_nights` to
-- `max_nights`; `flex_rotation` is the index of the stay an area watch
-- checked last (-1: none yet).
ALTER TABLE "travel_hotel_watch" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'hotel';
ALTER TABLE "travel_hotel_watch" ADD COLUMN IF NOT EXISTS "min_stars" integer;
ALTER TABLE "travel_hotel_watch" ADD COLUMN IF NOT EXISTS "min_rating" double precision;
ALTER TABLE "travel_hotel_watch" ADD COLUMN IF NOT EXISTS "flexible" boolean NOT NULL DEFAULT false;
ALTER TABLE "travel_hotel_watch" ADD COLUMN IF NOT EXISTS "min_nights" integer;
ALTER TABLE "travel_hotel_watch" ADD COLUMN IF NOT EXISTS "max_nights" integer;
ALTER TABLE "travel_hotel_watch" ADD COLUMN IF NOT EXISTS "flex_rotation" integer NOT NULL DEFAULT -1;

-- The stay a check priced (with flexible dates it changes from check to
-- check), the hotel of its matching offer (area watches) and, for a hotel
-- with flexible dates, the cheapest stays the price calendar estimated.
ALTER TABLE "travel_hotel_check" ADD COLUMN IF NOT EXISTS "check_in" date;
ALTER TABLE "travel_hotel_check" ADD COLUMN IF NOT EXISTS "check_out" date;
ALTER TABLE "travel_hotel_check" ADD COLUMN IF NOT EXISTS "matching_hotel" text;
ALTER TABLE "travel_hotel_check" ADD COLUMN IF NOT EXISTS "stays" jsonb;

-- The hotel of an offer of an area watch.
ALTER TABLE "travel_hotel_offer" ADD COLUMN IF NOT EXISTS "hotel" text;
