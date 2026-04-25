-- Mid-fetch TAN-session support: when the bank demands SCA on a
-- per-account "Umsatzabfrage" with a coupled method (photoTAN,
-- chipTAN, …), we now suspend the iteration in runFetchAccounts and
-- persist the loop state on the tan_session row so the resume path
-- in tan-sessions.complete can pick up where we left off.
--
--   kind           : 'sync' (init dialog) or 'statements' (mid-fetch)
--   fetch_context  : JSON state for the statements branch — which
--                    account we were processing when the bank asked
--                    for the TAN, plus the queue of accounts still
--                    waiting their turn after this one.
--
-- Existing rows default to kind='sync' so the in-flight init-dialog
-- sessions continue to work without disruption.

ALTER TABLE finance_tan_session
    ADD COLUMN IF NOT EXISTS kind          TEXT NOT NULL DEFAULT 'sync',
    ADD COLUMN IF NOT EXISTS fetch_context JSONB;
