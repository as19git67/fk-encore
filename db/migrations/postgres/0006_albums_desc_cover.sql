ALTER TABLE "albums" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "albums" ADD COLUMN "cover_photo_id" integer;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_cover_photo_id_photos_id_fk" FOREIGN KEY ("cover_photo_id") REFERENCES "public"."photos"("id") ON DELETE set null ON UPDATE no action;