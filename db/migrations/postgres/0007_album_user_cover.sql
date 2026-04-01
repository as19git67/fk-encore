ALTER TABLE "album_user_settings" ADD COLUMN "cover_photo_id" integer;--> statement-breakpoint
ALTER TABLE "album_user_settings" ADD CONSTRAINT "album_user_settings_cover_photo_id_photos_id_fk" FOREIGN KEY ("cover_photo_id") REFERENCES "public"."photos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

