-- Gemma's critique of one photo in words (documentation/plans/foto-aesthetik.md, stage 6).
CREATE TABLE IF NOT EXISTS "photo_critique" (
  "photo_id" integer PRIMARY KEY NOT NULL REFERENCES "photos"("id") ON DELETE CASCADE,
  "summary" text NOT NULL,
  "strengths" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "weaknesses" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "model" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
