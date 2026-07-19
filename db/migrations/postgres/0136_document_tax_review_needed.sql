-- Decouple the "subject-person personal-deduction" tax review signal from the
-- category classification confidence (see documents/document-ops.ts). Until now
-- a document that concerns a Bezugsperson AND carries a personal-deduction tax
-- section had its `classification_confidence` forced down to 0.55, which pushed
-- it into the low-confidence work-item basket even though the category was
-- classified confidently. That conflated "the AI is unsure about the category"
-- with "please check whether YOU paid this deductible expense".
--
-- This column carries the tax-review signal on its own so the basket can stop
-- reacting to it and the category confidence stays honest.
ALTER TABLE documents
  ADD COLUMN tax_review_needed BOOLEAN NOT NULL DEFAULT false;

-- Partial index for the tax-area "zu prüfen" filter (few rows expected).
CREATE INDEX documents_tax_review_needed_idx
  ON documents (tax_review_needed)
  WHERE tax_review_needed = true;

-- Backfill: mark the documents that the old confidence-lowering guard would
-- have flagged, so they leave the basket immediately once the query excludes
-- this flag. Matches the exact runtime condition in
-- detectSubjectPersonPersonalDeductionReview: an un-reviewed document that is
-- linked to a Bezugsperson and has at least one personal-deduction tax section.
UPDATE documents d
SET tax_review_needed = true
WHERE d.tax_reviewed = false
  AND EXISTS (
    SELECT 1 FROM document_subject_persons dsp
    WHERE dsp.document_id = d.id
  )
  AND EXISTS (
    SELECT 1 FROM document_tax_sections dts
    WHERE dts.document_id = d.id
      AND dts.tax_section IN (
        'sonderausgaben',
        'vorsorgeaufwand',
        'anlage-av',
        'aussergewoehnliche',
        'haushaltsnahe',
        'anlage-kind',
        'anlage-energetisch'
      )
  );
