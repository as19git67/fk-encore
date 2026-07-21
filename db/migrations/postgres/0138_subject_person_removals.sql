-- Explicit user removals of Bezugsperson links (issue: manually deselected
-- persons reappeared immediately).
--
-- Two mechanisms brought a deleted person back:
--   1. The save path only deleted source='user' links, so an AI-detected
--      link could never be removed from the edit dialog at all.
--   2. The learned-rules merge re-links a person the user consistently
--      files for the same sender on every re-classify — deliberately even
--      when the name is absent from the text (OCR-garble rescue), which
--      also resurrects an explicit removal.
--
-- This table remembers "the user removed THIS person from THIS document".
-- The save path records deselected links here; runClassify filters both the
-- deterministic detection and the learned merge against it. Re-adding the
-- person manually clears the row again.
CREATE TABLE document_subject_person_removals (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  subject_person_id INTEGER NOT NULL REFERENCES user_subject_persons(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, subject_person_id)
);
