-- Migration 0146: Own tax return per subject person (follow-up to #991).
--
-- An adult child (or any Bezugsperson) may file their own tax return from a
-- given tax year on while still living in the user's household. Documents of
-- such a person from those years belong to the person's own "Steuerakte"
-- rather than the user's tax review queue.

-- NULL = the person does not file their own return. A year value means:
-- tax documents with tax_year >= this value belong to this person's own
-- tax return, not the user's.
ALTER TABLE user_subject_persons
  ADD COLUMN own_tax_return_from_tax_year INTEGER;--> statement-breakpoint

-- Routing target for tax documents: when set, this document belongs to the
-- referenced Bezugsperson's own tax return ("Steuerakte") instead of the
-- user's. ON DELETE SET NULL: removing the person releases the documents
-- back into the general pool without deleting them.
ALTER TABLE documents
  ADD COLUMN tax_return_person_id INTEGER
    REFERENCES user_subject_persons(id) ON DELETE SET NULL;--> statement-breakpoint

CREATE INDEX idx_documents_tax_return_person_id
  ON documents (tax_return_person_id)
  WHERE tax_return_person_id IS NOT NULL;
