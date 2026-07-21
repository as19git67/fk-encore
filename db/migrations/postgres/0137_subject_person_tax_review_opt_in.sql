-- Migration 0136 flagged EVERY Bezugsperson mention on a personal-deduction
-- tax section as tax_review_needed, regardless of who the person is. In
-- practice a household's subject persons are usually a mix of dependents
-- the user actually pays for (spouse, own children — the deduction is
-- unambiguously theirs) and external relatives (e.g. a parent) whose bills
-- the user may or may not have covered. Flagging both alike flooded the
-- "zu prüfen" queue with documents that never needed a second look.
--
-- Make the signal opt-in per Bezugsperson: only subject persons explicitly
-- marked here trigger the review flag at classify time (see
-- documents/document-ops.ts).
ALTER TABLE user_subject_persons
  ADD COLUMN requires_tax_review BOOLEAN NOT NULL DEFAULT false;

-- Clear the blanket flags set by 0136's backfill / the classifier so far —
-- none of them originate from an opted-in subject person yet, since the
-- column above defaults to false for every existing row.
UPDATE documents
SET tax_review_needed = false
WHERE tax_review_needed = true;
