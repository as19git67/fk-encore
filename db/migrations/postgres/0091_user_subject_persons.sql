-- Migration 0091: Per-user "Bezugspersonen" (subject persons) list.
--
-- Maps a personal-context name as it appears on documents
-- (e.g. "Erika Mustermann") to the user's relationship-tag
-- (e.g. "mutter"). The classify step in document-ops/runClassify
-- forwards this list to the LLM so that a Sozialstation invoice
-- addressed to a parent automatically picks up the `mutter` /
-- `vater` / … tag without manual edits.
--
-- The relation_tag is intentionally a free-form short string. We
-- normalise to lowercase at the application boundary; relation_tag
-- values reused across persons (both parents → `eltern`) are fine.

CREATE TABLE user_subject_persons (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name     TEXT NOT NULL,
  relation_tag  TEXT NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);--> statement-breakpoint

CREATE INDEX idx_user_subject_persons_user_id
  ON user_subject_persons (user_id);--> statement-breakpoint

-- Prevent the same person being entered twice for one user (case-
-- insensitive). Different users can independently list "Hans Meier".
CREATE UNIQUE INDEX uq_user_subject_persons_user_name
  ON user_subject_persons (user_id, lower(full_name));
