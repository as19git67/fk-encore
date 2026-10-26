-- Photo books (documentation/plans/fotobuch.md, issue #1729): a book holds
-- chapters, pages in reading order and the photos in each page's cells. A
-- deleted photo drops out of its cell by cascade; the editor re-lays that
-- page the next time it is touched.
CREATE TABLE IF NOT EXISTS "photo_book" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "subtitle" text,
  "format" text NOT NULL DEFAULT 'a4-landscape',
  "cover_photo_id" integer REFERENCES "photos"("id") ON DELETE SET NULL,
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "source" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photo_book_by_user" ON "photo_book" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "photo_book_chapter" (
  "id" serial PRIMARY KEY,
  "book_id" integer NOT NULL REFERENCES "photo_book"("id") ON DELETE CASCADE,
  "position" integer NOT NULL,
  "title" text NOT NULL,
  "subtitle" text,
  "starts_at" timestamp,
  "ends_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photo_book_chapter_by_book" ON "photo_book_chapter" ("book_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "photo_book_page" (
  "id" serial PRIMARY KEY,
  "book_id" integer NOT NULL REFERENCES "photo_book"("id") ON DELETE CASCADE,
  "chapter_id" integer REFERENCES "photo_book_chapter"("id") ON DELETE CASCADE,
  "position" integer NOT NULL,
  "kind" text NOT NULL,
  "layout" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photo_book_page_by_book" ON "photo_book_page" ("book_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "photo_book_slot" (
  "page_id" integer NOT NULL REFERENCES "photo_book_page"("id") ON DELETE CASCADE,
  "slot" integer NOT NULL,
  "photo_id" integer NOT NULL REFERENCES "photos"("id") ON DELETE CASCADE,
  PRIMARY KEY ("page_id", "slot")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photo_book_slot_by_photo" ON "photo_book_slot" ("photo_id");
