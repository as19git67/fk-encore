-- Wikipedia articles as the app shows them (2026-10-04, §25 stage C).
--
-- One row per article, keyed by edition and title: the German text where
-- German exists, otherwise the local text with its translation by the
-- llm-service. Per article rather than per trip or person — the
-- Colosseum reads the same for everybody, and a translation is the one
-- answer that costs minutes.
CREATE TABLE "trip_wiki_articles" (
  "id" serial PRIMARY KEY NOT NULL,
  "lang" text NOT NULL,
  "title" text NOT NULL,
  "article" jsonb NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "trip_wiki_articles_key" ON "trip_wiki_articles" USING btree ("lang","title");
