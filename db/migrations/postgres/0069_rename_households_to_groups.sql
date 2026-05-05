-- Migration 0069: Rename households to groups
ALTER TABLE households RENAME TO groups;
ALTER TABLE household_members RENAME TO group_members;

ALTER TABLE group_members RENAME COLUMN household_id TO group_id;
ALTER TABLE documents RENAME COLUMN household_id TO group_id;

-- Rename Enums
ALTER TYPE household_member_role RENAME TO group_member_role;
-- We'll keep the values in document_visibility as they are or rename 'household' to 'group'
ALTER TYPE document_visibility RENAME VALUE 'household' TO 'group';

-- Update CHECK constraint on documents
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_visibility_household_consistent;
ALTER TABLE documents ADD CONSTRAINT documents_visibility_group_consistent 
    CHECK ((visibility = 'private' AND group_id IS NULL) OR (visibility = 'group' AND group_id IS NOT NULL));

-- Rename Indices
ALTER INDEX IF EXISTS idx_documents_household_id RENAME TO idx_documents_group_id;
ALTER INDEX IF EXISTS idx_household_members_user_id RENAME TO idx_group_members_user_id;
