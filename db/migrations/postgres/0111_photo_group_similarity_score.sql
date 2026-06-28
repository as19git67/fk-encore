ALTER TABLE photo_group_members
  ADD COLUMN IF NOT EXISTS similarity_score real;
