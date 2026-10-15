-- The assistant's conversations (documentation/plans/ki-assistent.md,
-- stage 2, issue #1527).
--
-- A conversation belongs to one user and is deleted with them. Messages keep
-- the OpenAI turn shape the agent loop replays: the user's question, the
-- model's tool calls, the tools' compact results and the final answer.
-- `blocks` holds the typed result rows the client renders beside the text.
CREATE TABLE "assistant_conversation" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "title" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "assistant_conversation_by_user" ON "assistant_conversation" ("user_id", "updated_at" DESC);
--> statement-breakpoint
CREATE TABLE "assistant_message" (
  "id" serial PRIMARY KEY,
  "conversation_id" integer NOT NULL REFERENCES "assistant_conversation"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "content" text,
  "tool_calls" jsonb,
  "tool_call_id" text,
  "blocks" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "assistant_message_by_conversation" ON "assistant_message" ("conversation_id", "id");
