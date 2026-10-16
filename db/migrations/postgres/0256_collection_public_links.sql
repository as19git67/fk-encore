-- Anonymous share links of a collection (#1548, stage 8): anyone holding the
-- token sees the collection's photos, albums and documents as they are now,
-- as far as the person who made the link may see them. Soft-deleted like the
-- album links, so an old URL stays dead instead of being reused.
CREATE TABLE "collection_public_links" (
  "id" serial PRIMARY KEY,
  "collection_id" integer NOT NULL REFERENCES "document_collections"("id") ON DELETE CASCADE,
  "token" text NOT NULL UNIQUE,
  "created_by_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone,
  "disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "collection_public_links_by_collection" ON "collection_public_links" ("collection_id");
