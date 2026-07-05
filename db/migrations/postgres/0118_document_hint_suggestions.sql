-- Weekly hint-mining output: AI-derived improvements for tax-section hints
-- and category hints, surfaced to the admin for review.

CREATE TABLE IF NOT EXISTS "document_hint_suggestions" (
  "id" serial PRIMARY KEY,
  "kind" text NOT NULL,
  "target_slug" text NOT NULL,
  "draft_hint" text NOT NULL,
  "rationale" text,
  "example_document_ids" integer[] NOT NULL DEFAULT '{}'::integer[],
  "status" "document_suggestion_status" NOT NULL DEFAULT 'open',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "document_hint_suggestions_target_uniq"
  ON "document_hint_suggestions" ("kind", "target_slug")
  WHERE "status" = 'open';
