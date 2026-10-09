-- Reference numbers as a field of their own (#1479).
--
-- `document_number` holds only the document's own "#1234" sticker; the
-- contract, policy, customer and case numbers the text carries were thrown
-- away as noise for that field (and survive only as lower-cased tags). They
-- are what a household files by, so they get a typed, normalised, searchable
-- place: `[{ kind, value, normalized, source }]`, where `normalized` is the
-- value without spaces, dots, dashes and slashes, upper-cased, so
-- "AB 12.345-6" and "ab123456" meet. The GIN index serves the containment
-- lookup `reference_numbers @> '[{"normalized": "AB123456"}]'`.
ALTER TABLE "documents" ADD COLUMN "reference_numbers" jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX "documents_reference_numbers_idx" ON "documents" USING GIN ("reference_numbers" jsonb_path_ops);
