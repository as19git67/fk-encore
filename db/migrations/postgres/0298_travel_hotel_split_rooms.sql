ALTER TABLE "travel_hotel_watch" ADD COLUMN "split_rooms" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "travel_hotel_offer" ADD COLUMN "rooms" integer DEFAULT 1 NOT NULL;
