-- Migration 0133: manual "queue for Cloud-Teacher" flag on documents.
--
-- Lets a user mark a document they find hard to classify so the offline
-- Cloud-Teacher (scripts/taxonomy/cloud_teacher.py) picks it up on its next
-- run with top priority, ahead of the thin-branch / focus / newest buckets.
--
-- Semantics: `teacher_requested` is a request, not a result. The teacher only
-- acts on documents whose category is still untrusted
-- (category_source = 'ai' AND attributes_reviewed = false), and clears the flag
-- once it has written a label — so a requested-but-already-trusted document is
-- simply skipped and the flag stays until it becomes actionable. `requested_at`
-- records when the flag was set (informational / ordering).

ALTER TABLE documents
  ADD COLUMN teacher_requested BOOLEAN NOT NULL DEFAULT false;--> statement-breakpoint

ALTER TABLE documents
  ADD COLUMN teacher_requested_at TIMESTAMP;--> statement-breakpoint

-- Partial index: the teacher's priority bucket queries only the (usually tiny)
-- set of flagged documents, so keep that lookup cheap without indexing the
-- overwhelmingly-false majority.
CREATE INDEX documents_teacher_requested_idx
  ON documents (teacher_requested)
  WHERE teacher_requested = true;
