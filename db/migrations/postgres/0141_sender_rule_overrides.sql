-- Migration 0141: Household-global sender → category rule overrides.
--
-- Lets a user pin how a sender (optionally gated by title/text keywords)
-- routes to a taxonomy category, without hard-coding household-specific
-- institution names (employer, parish, etc.) in the public source tree. See
-- documents/sender-rule-overrides.ts and documents/sender-rules.ts
-- (matchSenderRule).
--
-- Global (not per-user), consistent with the built-in deterministic sender
-- rules. Evaluated BEFORE the built-in rules, ordered by sort_order ascending
-- (lower first) so a household can order a specific case ahead of a fallback
-- for the same sender fragment.

CREATE TABLE document_sender_rule_overrides (
  id SERIAL PRIMARY KEY,
  note TEXT,
  sender_pattern TEXT NOT NULL,
  require_any TEXT[],
  exclude_any TEXT[],
  category TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX document_sender_rule_overrides_sort_idx
  ON document_sender_rule_overrides (sort_order, id);
