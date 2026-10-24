-- Migration 0274: Marker for one-time imports into document_sender_rule_overrides.
--
-- The built-in SENDER_RULES in documents/sender-rules.ts name the institutions
-- this household deals with — insurers, banks, doctors, the tax advisor. That
-- does not belong in a public source tree, so the rules move into the
-- database table that already holds the household's own rules (0141). The
-- seed copies them over once (db/seed-sender-rules.ts) and records it here;
-- afterwards the table is the only source and a rule deleted or edited there
-- stays that way. A later PR empties the list in the code.
--
-- The rules themselves are deliberately NOT inserted by this migration: an
-- INSERT here would put the same names back into the repository.

CREATE TABLE document_sender_rule_imports (
  key TEXT PRIMARY KEY,
  rule_count INTEGER NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
