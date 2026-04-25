-- Add 'bargeld' to the finance_account_kind enum. Postgres requires the
-- ADD VALUE to be committed before the enum value can be referenced (see
-- migration 0055 for the matching seed row), so this migration is kept
-- intentionally small.

ALTER TYPE finance_account_kind ADD VALUE IF NOT EXISTS 'bargeld' BEFORE 'sonstige';
