-- Repair: 0313 and 0314 carry a journal timestamp older than 0312. Drizzle
-- runs a migration only when its timestamp is newer than the last one
-- applied, so a database that had already run 0312 skipped both and lacked
-- `finance_account.watch_from` (every account query failed) and the columns
-- of hotel area watches. This migration repeats both; every statement is
-- idempotent, so a database that did run them is unchanged.
ALTER TABLE "travel_hotel_watch" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'hotel';
--> statement-breakpoint
ALTER TABLE "travel_hotel_watch" ADD COLUMN IF NOT EXISTS "min_stars" integer;
--> statement-breakpoint
ALTER TABLE "travel_hotel_watch" ADD COLUMN IF NOT EXISTS "min_rating" double precision;
--> statement-breakpoint
ALTER TABLE "travel_hotel_watch" ADD COLUMN IF NOT EXISTS "flexible" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "travel_hotel_watch" ADD COLUMN IF NOT EXISTS "min_nights" integer;
--> statement-breakpoint
ALTER TABLE "travel_hotel_watch" ADD COLUMN IF NOT EXISTS "max_nights" integer;
--> statement-breakpoint
ALTER TABLE "travel_hotel_watch" ADD COLUMN IF NOT EXISTS "flex_rotation" integer NOT NULL DEFAULT -1;
--> statement-breakpoint
ALTER TABLE "travel_hotel_check" ADD COLUMN IF NOT EXISTS "check_in" date;
--> statement-breakpoint
ALTER TABLE "travel_hotel_check" ADD COLUMN IF NOT EXISTS "check_out" date;
--> statement-breakpoint
ALTER TABLE "travel_hotel_check" ADD COLUMN IF NOT EXISTS "matching_hotel" text;
--> statement-breakpoint
ALTER TABLE "travel_hotel_check" ADD COLUMN IF NOT EXISTS "stays" jsonb;
--> statement-breakpoint
ALTER TABLE "travel_hotel_offer" ADD COLUMN IF NOT EXISTS "hotel" text;
--> statement-breakpoint
ALTER TABLE "finance_account" ADD COLUMN IF NOT EXISTS "watch_from" date;
