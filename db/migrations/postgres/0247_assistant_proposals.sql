-- Write actions of the assistant as proposals the user confirms
-- (documentation/plans/ki-assistent.md, stage 4, issue #1529).
--
-- A write tool never acts: it stores what it would do, with the arguments
-- already resolved (the photo ids an album would get), and the chat shows a
-- card. Only the proposal's own user can execute it, and only once — the
-- status moves from `pending` to `executed` or `discarded` exactly one time.
CREATE TABLE "assistant_proposal" (
  "id" serial PRIMARY KEY,
  "conversation_id" integer REFERENCES "assistant_conversation"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "tool" text NOT NULL,
  "arguments" jsonb NOT NULL,
  "summary" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'executing', 'executed', 'discarded')),
  "result" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "assistant_proposal_by_user" ON "assistant_proposal" ("user_id", "created_at" DESC);
