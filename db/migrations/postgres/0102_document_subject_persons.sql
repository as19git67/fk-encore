-- Migration 0102: First-class "Bezugsperson" link per document.
--
-- Until now the only per-document trace of a Bezugsperson was an LLM-emitted
-- relation tag in the generic tag list — fragile and not recognisable as a
-- subject person. This N:M table links a document to the owner's
-- `user_subject_persons` rows. `source='ai'` rows are detected deterministically
-- at classify time (name found in the document text) and replaced on every
-- re-classify; `source='user'` rows are set via the edit dialog and survive.

CREATE TABLE document_subject_persons (
  document_id       INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  subject_person_id INTEGER NOT NULL REFERENCES user_subject_persons(id) ON DELETE CASCADE,
  source            TEXT NOT NULL DEFAULT 'ai',
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, subject_person_id)
);

CREATE INDEX idx_document_subject_persons_person
  ON document_subject_persons (subject_person_id);
