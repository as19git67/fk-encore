-- Migration 0145: Family hierarchy for tax classifier context (#991).
--
-- Extends user_subject_persons with typed relations so the classifier
-- receives structured household context instead of guessing relationships
-- from free-form tags. Adds an effective-dated assessment_type setting
-- per user so spouse deductions can be resolved deterministically.

-- ── New columns on user_subject_persons ─────────────────────────────────────

ALTER TABLE user_subject_persons
  ADD COLUMN relation_kind TEXT NOT NULL DEFAULT 'other';--> statement-breakpoint

ALTER TABLE user_subject_persons
  ADD COLUMN birth_date DATE;--> statement-breakpoint

ALTER TABLE user_subject_persons
  ADD COLUMN in_household BOOLEAN NOT NULL DEFAULT false;--> statement-breakpoint

ALTER TABLE user_subject_persons
  ADD COLUMN tax_cost_bearer TEXT NOT NULL DEFAULT 'unknown';--> statement-breakpoint

-- NULL = follow the derived default; true/false = manual override.
-- The effective value is always written into requires_tax_review so
-- existing readers (document-ops.ts, syncTaxReviewFlagForSubjectPerson)
-- keep working unchanged.
ALTER TABLE user_subject_persons
  ADD COLUMN requires_tax_review_override BOOLEAN;--> statement-breakpoint

-- Freeze every existing row's current requires_tax_review as an explicit
-- override. Without this, the migration itself would flip existing
-- Bezugspersonen to the derived default for relation_kind='other' (which
-- is "review needed") and flood the review queue — the exact failure 0137
-- fixed.
UPDATE user_subject_persons
SET requires_tax_review_override = requires_tax_review;--> statement-breakpoint

-- At most one 'self' entry per user.
CREATE UNIQUE INDEX uq_user_subject_persons_self
  ON user_subject_persons (user_id)
  WHERE relation_kind = 'self';--> statement-breakpoint

-- ── Assessment settings (effective-dated per user) ──────────────────────────

CREATE TABLE user_assessment_settings (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assessment_type     TEXT NOT NULL DEFAULT 'unknown',
  valid_from_tax_year INTEGER,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);--> statement-breakpoint

CREATE UNIQUE INDEX uq_user_assessment_settings_user_year
  ON user_assessment_settings (user_id, COALESCE(valid_from_tax_year, 0));--> statement-breakpoint

CREATE INDEX idx_user_assessment_settings_user_id
  ON user_assessment_settings (user_id);
