-- A Sammelmappe can sort itself (documents/collection-sort.ts): up to three
-- keys among correspondent, title and document date. NULL keeps the order a
-- person set by dragging.
ALTER TABLE "document_collections" ADD COLUMN "sort_order" jsonb;
