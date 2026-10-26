-- A thumbs-up or -down under an assistant answer (stage 6 of
-- documentation/plans/assistent-wegfindung.md): the question, the tool trace
-- of that turn (tool, arguments, row count, error — never row content) and
-- the answer are copied in, so an entry outlives its conversation and can
-- be turned into a benchmark case by hand. One entry per answer.
CREATE TABLE IF NOT EXISTS "assistant_feedback" (
  "id" serial PRIMARY KEY,
  "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "conversation_id" integer REFERENCES "assistant_conversation"("id") ON DELETE SET NULL,
  "message_id" integer REFERENCES "assistant_message"("id") ON DELETE SET NULL,
  "verdict" text NOT NULL,
  "comment" text,
  "question" text NOT NULL,
  "trace" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "answer" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "assistant_feedback_by_message" ON "assistant_feedback" ("message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_feedback_by_created" ON "assistant_feedback" ("created_at");
