-- The basket becomes a collection, and saved finance baskets become
-- transaction collections (issue #1548, stage 2).
--
-- Every user has at most one basket: the unnamed, mixed collection of what
-- they set aside while working. It is a row like any other collection with
-- `kind = 'basket'`, so membership, access and export are the collections'.
CREATE UNIQUE INDEX "document_collections_one_basket_per_user"
  ON "document_collections" ("user_id") WHERE "kind" = 'basket';
--> statement-breakpoint
-- Saved finance baskets were transaction collections in all but name. Each
-- is copied into a private collection typed for transactions, keeping its
-- name, dates and order; transactions deleted since are left behind. The old
-- table stays untouched as a backup and is no longer written.
ALTER TABLE "document_collections" ADD COLUMN "migrated_snapshot_id" bigint;
--> statement-breakpoint
INSERT INTO "document_collections"
  ("user_id", "title", "visibility", "kind", "entity_type", "summary_stale",
   "created_at", "updated_at", "migrated_snapshot_id")
SELECT "user_id", "name", 'private', 'manual', 'transaction', false,
       "created_at", "updated_at", "id"
FROM "finance_basket_snapshot"
ORDER BY "id";
--> statement-breakpoint
INSERT INTO "collection_members" ("collection_id", "entity_type", "entity_id", "added_by", "added_at")
SELECT c."id", 'transaction', t."tx_id", s."user_id", s."updated_at"
FROM "finance_basket_snapshot" s
JOIN "document_collections" c ON c."migrated_snapshot_id" = s."id"
CROSS JOIN LATERAL unnest(s."tx_ids") WITH ORDINALITY AS t("tx_id", "ord")
JOIN "finance_transaction" ft ON ft."id" = t."tx_id"
ORDER BY c."id", t."ord"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "document_collections" DROP COLUMN "migrated_snapshot_id";
