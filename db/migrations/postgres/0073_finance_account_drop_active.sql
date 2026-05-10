-- Drop the `active` column on finance_account.
--
-- Originally `active` was a "show in overview" toggle — independent of
-- closed_at and not respected by sync or the booking-insert path. Since
-- closed_at now covers the "this account is no longer in use" case
-- end-to-end (sync skip + booking refusal + overview filter), the
-- `active` flag is redundant and the dual semantics confuse the UI.

ALTER TABLE finance_account
    DROP COLUMN active;
