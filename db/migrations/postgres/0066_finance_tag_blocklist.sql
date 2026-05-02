-- AI-tag suggestion block list.
--
-- When the user explicitly rejects an AI-suggested tag we record the
-- (account, counterparty, tag) tuple here. The tag suggester consults
-- this table before persisting suggestions, so the LLM doesn't keep
-- re-emitting the same wrong label for transactions of that counterparty
-- on that account.
--
-- counterparty is lowercased + trimmed at insert time so the lookup is a
-- straight equality test. Cash transactions (no counterparty) use the
-- empty string as the blocklist key.

CREATE TABLE IF NOT EXISTS finance_tag_blocklist (
  id                BIGSERIAL PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES finance_account(id) ON DELETE CASCADE,
  counterparty_norm TEXT NOT NULL,
  tag_name          TEXT NOT NULL,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, counterparty_norm, tag_name)
);

CREATE INDEX IF NOT EXISTS idx_finance_tag_blocklist_lookup
  ON finance_tag_blocklist (account_id, counterparty_norm);
