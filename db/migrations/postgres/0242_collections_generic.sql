-- Collections for every entity type (issue #1548, stage 1).
--
-- A Sammelmappe was a folder of documents. It becomes a folder of anything:
-- photos, albums, transactions, securities, meters and single meter readings
-- join documents. The table keeps its name; `entity_type` says what a
-- collection may hold, NULL meaning "any type". Every existing row is a
-- document folder, so the column defaults to 'document' and existing rows
-- keep exactly what they were.
--
-- Documents stay in `document_collection_items`: their membership carries
-- what only a document has in a folder (order in the PDF, pages left out,
-- redactions). Every other type is a plain membership in
-- `collection_members`.
ALTER TABLE "document_collections" ADD COLUMN "entity_type" text DEFAULT 'document';
--> statement-breakpoint
ALTER TABLE "document_collections" ADD CONSTRAINT "document_collections_entity_type_check"
  CHECK ("entity_type" IS NULL OR "entity_type" IN
    ('document', 'photo', 'album', 'transaction', 'security', 'meter', 'meter_reading'));
--> statement-breakpoint
ALTER TABLE "document_collections" ADD COLUMN "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "document_collections" ADD COLUMN "created_by" text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_collections" ADD CONSTRAINT "document_collections_created_by_check"
  CHECK ("created_by" IN ('user', 'assistant'));
--> statement-breakpoint
CREATE TABLE "collection_members" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "collection_id" integer NOT NULL REFERENCES "document_collections"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL,
  "entity_id" bigint NOT NULL,
  "joined_by" text DEFAULT 'user' NOT NULL,
  "added_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "collection_members_entity_type_check"
    CHECK ("entity_type" IN ('photo', 'album', 'transaction', 'security', 'meter', 'meter_reading')),
  CONSTRAINT "collection_members_joined_by_check" CHECK ("joined_by" IN ('user', 'rule'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "collection_members_member_key"
  ON "collection_members" ("collection_id", "entity_type", "entity_id");
--> statement-breakpoint
CREATE INDEX "collection_members_entity_idx" ON "collection_members" ("entity_type", "entity_id");
--> statement-breakpoint
-- Per reader, not per folder: in a group folder each member stars and opens
-- it for themselves.
CREATE TABLE "collection_user_state" (
  "collection_id" integer NOT NULL REFERENCES "document_collections"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "favourite" boolean DEFAULT false NOT NULL,
  "last_opened_at" timestamp with time zone,
  PRIMARY KEY ("collection_id", "user_id")
);
--> statement-breakpoint
-- A member points at a row of another table without a foreign key (one column
-- serves six tables). These triggers take the membership away with the row,
-- so a deleted photo does not linger as an unresolvable member.
CREATE FUNCTION "collection_members_forget"() RETURNS trigger AS $$
BEGIN
  DELETE FROM "collection_members"
   WHERE "entity_type" = TG_ARGV[0] AND "entity_id" = OLD."id";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "collection_members_forget_photo" AFTER DELETE ON "photos"
  FOR EACH ROW EXECUTE FUNCTION "collection_members_forget"('photo');
--> statement-breakpoint
CREATE TRIGGER "collection_members_forget_album" AFTER DELETE ON "albums"
  FOR EACH ROW EXECUTE FUNCTION "collection_members_forget"('album');
--> statement-breakpoint
CREATE TRIGGER "collection_members_forget_transaction" AFTER DELETE ON "finance_transaction"
  FOR EACH ROW EXECUTE FUNCTION "collection_members_forget"('transaction');
--> statement-breakpoint
CREATE TRIGGER "collection_members_forget_security" AFTER DELETE ON "finance_depot_security"
  FOR EACH ROW EXECUTE FUNCTION "collection_members_forget"('security');
--> statement-breakpoint
CREATE TRIGGER "collection_members_forget_meter" AFTER DELETE ON "meters"
  FOR EACH ROW EXECUTE FUNCTION "collection_members_forget"('meter');
--> statement-breakpoint
CREATE TRIGGER "collection_members_forget_meter_reading" AFTER DELETE ON "meter_readings"
  FOR EACH ROW EXECUTE FUNCTION "collection_members_forget"('meter_reading');
