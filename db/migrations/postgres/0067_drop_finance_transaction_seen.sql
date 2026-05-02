-- Drop the per-user transaction-read tracker.
--
-- The "seen" feature was superseded by the overview-card pending_count
-- badge, which is global per account, gated by a 30-day window, and
-- tied to the presence of a user-tag rather than a viewing event. With
-- both signals around, the seen marker confused more than it helped:
-- viewing a transaction silently flipped one indicator while the badge
-- ticked down on a different schedule.
--
-- Drop the table outright. The data is per-user UI state, not business
-- truth — losing it has no operational impact.

DROP INDEX IF EXISTS idx_finance_transaction_seen_user;
DROP TABLE IF EXISTS finance_transaction_seen;
