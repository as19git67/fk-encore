-- Add 'bargeld' to the finance_account_kind enum + seed the matching
-- finance_account_type row so the Finanzkraft import (which has a
-- dedicated cash account type, not a generic "sonstige") can land on
-- a clean kind. The frontend uses the kind to switch UI affordances —
-- e.g. cash wallets shouldn't offer SEPA-style metadata fields.

ALTER TYPE finance_account_kind ADD VALUE IF NOT EXISTS 'bargeld' BEFORE 'sonstige';

INSERT INTO finance_account_type (kind, label)
VALUES ('bargeld', 'Bargeld')
ON CONFLICT (kind) DO NOTHING;
