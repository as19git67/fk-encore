ALTER TABLE "travel_hotel_watch" ADD COLUMN "notify_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "travel_hotel_watch" ADD COLUMN "notify_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "travel_hotel_watch" ADD COLUMN "notified_per_night" double precision;--> statement-breakpoint
ALTER TABLE "travel_hotel_watch" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "travel_hotel_offer" ALTER COLUMN "free_cancellation" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "travel_hotel_offer" ALTER COLUMN "free_cancellation" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "travel_hotel_offer" ADD COLUMN "link" text;--> statement-breakpoint
-- A provider without a room list carried "not cancellable" so far; Google named no terms for it.
UPDATE "travel_hotel_offer" SET "free_cancellation" = NULL WHERE "room" = '(ohne Zimmerangabe)' AND "free_cancellation" = false;
