-- Migration 0131: Household-global correspondent overrides.
--
-- Lets a user pin how a sender maps to a correspondent, overriding the
-- built-in registry in documents/correspondent.ts. When a document's
-- normalised sender contains `sender_pattern`, the resolver forces the
-- given slug/display — used to unify near-duplicate senders or correct a
-- wrong auto-derived correspondent.
--
-- Global (not per-user), consistent with the deterministic sender rules.
-- Changing an override takes effect for a document the next time it is
-- (re)located (e.g. via the "Dateinamen aktualisieren" backfill).

CREATE TABLE document_correspondent_overrides (
  id SERIAL PRIMARY KEY,
  sender_pattern TEXT NOT NULL UNIQUE,
  correspondent_slug TEXT NOT NULL,
  correspondent_display TEXT NOT NULL,
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
