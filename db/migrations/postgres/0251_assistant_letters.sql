-- Letters drafted from selected context (documentation/plans/ki-assistent.md,
-- stage 8, issue #1534).
--
-- `assistant_conversation.context` is the working set the user handed the
-- assistant: documents, photos and bookings as {type, id}. The model gets a
-- short brief of each and asks for more only when it needs it.
--
-- `assistant_letter` keeps what a letter is made of, not its PDF: the PDF is
-- rendered from these fields on every download, so it never drifts from them.
-- `document_id` and `collection_id` point into the documents service, which
-- owns those rows; a letter outlives a deleted copy, so no foreign key.
--
-- `users.postal_address` is the sender block of a letter, kept once the user
-- has typed it on a letter card.
--
-- `document_links` ties a document to others it answers or encloses, so a
-- saved letter shows on the pages of the documents it was written about.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "postal_address" text;
--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD COLUMN IF NOT EXISTS "context" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant_letter" (
  "id" bigserial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "conversation_id" integer REFERENCES "assistant_conversation"("id") ON DELETE SET NULL,
  "sender" text NOT NULL,
  "recipient" text NOT NULL,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "letter_date" date NOT NULL,
  "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "document_id" integer,
  "collection_id" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_letter_by_user" ON "assistant_letter" ("user_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_links" (
  "id" serial PRIMARY KEY,
  "document_id" integer NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "linked_document_id" integer NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "document_links_not_self" CHECK ("document_id" <> "linked_document_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "document_links_pair" ON "document_links" ("document_id", "linked_document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_links_by_linked" ON "document_links" ("linked_document_id");
