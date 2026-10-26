-- Photo books, stages 2 and 3 (documentation/plans/fotobuch.md): captions
-- and chapter titles the local model proposes, and the layout it picks.
--
-- A caption belongs to a photo within a book, not to a slot: moving a photo
-- to another layout or page keeps its caption. `source` tells a caption the
-- user wrote ('user') from one the model proposed ('llm'); a new proposal
-- never replaces a user's caption.
CREATE TABLE IF NOT EXISTS "photo_book_caption" (
  "book_id" integer NOT NULL REFERENCES "photo_book"("id") ON DELETE CASCADE,
  "photo_id" integer NOT NULL REFERENCES "photos"("id") ON DELETE CASCADE,
  "text" text NOT NULL,
  "source" text NOT NULL,
  "model" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("book_id", "photo_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photo_book_caption_by_photo" ON "photo_book_caption" ("photo_id");
--> statement-breakpoint
-- Who wrote the chapter title: the date rule ('rule'), the model ('llm') or
-- the user ('user'). The model's proposal is kept in `title_suggestion` even
-- when the user's title stays.
ALTER TABLE "photo_book_chapter" ADD COLUMN IF NOT EXISTS "title_source" text NOT NULL DEFAULT 'rule';
--> statement-breakpoint
ALTER TABLE "photo_book_chapter" ADD COLUMN IF NOT EXISTS "title_suggestion" text;
--> statement-breakpoint
-- Captions on this page: null follows the book's setting.
ALTER TABLE "photo_book_page" ADD COLUMN IF NOT EXISTS "captions" boolean;
--> statement-breakpoint
-- Who picked the layout ('rule', 'llm', 'user'), who picked it before the
-- user changed it, the rule's own pick and the model's reason. Together they
-- measure whether the model's picks are kept as often as the rule's.
ALTER TABLE "photo_book_page" ADD COLUMN IF NOT EXISTS "layout_source" text NOT NULL DEFAULT 'rule';
--> statement-breakpoint
ALTER TABLE "photo_book_page" ADD COLUMN IF NOT EXISTS "layout_origin" text NOT NULL DEFAULT 'rule';
--> statement-breakpoint
ALTER TABLE "photo_book_page" ADD COLUMN IF NOT EXISTS "rule_layout" text;
--> statement-breakpoint
ALTER TABLE "photo_book_page" ADD COLUMN IF NOT EXISTS "layout_reason" text;
