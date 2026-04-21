-- Migration 0036: Household-based document sharing.
--
-- Introduces the concept of a household (a group of users who share the
-- same pool of documents) and extends the documents table with a
-- visibility flag + household reference. A document is either:
--
--   - visibility='private', household_id=NULL  → only the uploader sees it
--   - visibility='household', household_id=X   → every member of the
--     referenced household sees it
--
-- The uploader is still recorded in documents.user_id — that column
-- continues to mean "who put this file here", not "who is allowed to
-- see it". Access is now driven by visibility + household membership.
--
-- Existing documents keep their strict single-owner semantics
-- (visibility='private' default) so the migration is a no-op for
-- already-stored data. Creating households + opting documents in is a
-- deliberate user action afterwards.

CREATE TYPE document_visibility   AS ENUM ('private', 'household');--> statement-breakpoint
CREATE TYPE household_member_role AS ENUM ('owner', 'member');--> statement-breakpoint

CREATE TABLE households (
  id         SERIAL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);--> statement-breakpoint

CREATE TABLE household_members (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  role         household_member_role NOT NULL DEFAULT 'member',
  joined_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (household_id, user_id)
);--> statement-breakpoint

-- "Find every household a given user belongs to" is the hot path for
-- visibility resolution on every document query.
CREATE INDEX idx_household_members_user_id ON household_members (user_id);--> statement-breakpoint

ALTER TABLE documents
  ADD COLUMN visibility   document_visibility NOT NULL DEFAULT 'private',
  ADD COLUMN household_id INTEGER REFERENCES households(id) ON DELETE RESTRICT;--> statement-breakpoint

-- Consistency guard: the two columns must agree. A private document
-- never carries a household reference; a household document must.
-- ON DELETE RESTRICT (above) forces operators to reassign documents
-- before deleting a household — the alternative (SET NULL) would
-- violate this CHECK, and CASCADE would silently destroy user data.
ALTER TABLE documents
  ADD CONSTRAINT documents_visibility_household_consistent
    CHECK ((visibility = 'private'   AND household_id IS NULL)
        OR (visibility = 'household' AND household_id IS NOT NULL));--> statement-breakpoint

-- Partial index: only household-scoped rows need it. Private rows
-- (the majority, and all existing rows) are served by idx_documents_user_id.
CREATE INDEX idx_documents_household_id
  ON documents (household_id)
  WHERE household_id IS NOT NULL;
