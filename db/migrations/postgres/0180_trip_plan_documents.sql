-- Documents as fixed points (§3.4).
--
-- The documents service has had OCR, classification and semantic search
-- from the start, so the hotel confirmation, the train ticket, the
-- rental agreement and the museum slot are already in the house and
-- machine-readable. What was missing is the one row that says *this
-- paper belongs to that trip* — which is why the readiness check (§8.6)
-- could only answer "Tickets und Buchungen kann die App nicht prüfen".
--
-- Deliberately a link table and nothing more. The document keeps living
-- in the documents service under its own visibility rules; this table
-- adds no copy of its text, its title or its file. A participant who
-- may not see the document sees only that somebody attached one — the
-- trip is shared, the paperwork is not.
--
-- `role` is what the document does *for the trip* (lodging, transport,
-- rental, ticket), which is a different question from the documents
-- taxonomy's "what kind of paperwork is this". It is proposed by the
-- reading in trip-planner/doc-hints.ts and can be corrected by hand;
-- nothing validates it in the database, because a vocabulary that grows
-- should not need a migration.
CREATE TABLE IF NOT EXISTS trip_plan_documents (
  id serial PRIMARY KEY,
  plan_id integer NOT NULL REFERENCES trip_plans(id) ON DELETE CASCADE,
  document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'ticket',
  -- "Zimmer 4, Frühstück ab 7" — what the paper does not say itself.
  note text,
  -- Who attached it. Kept when that account goes: the link is the
  -- trip's, not the person's.
  linked_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Attaching the same document twice is the same statement twice.
  UNIQUE (plan_id, document_id)
);

CREATE INDEX IF NOT EXISTS trip_plan_documents_plan_idx
  ON trip_plan_documents (plan_id);
CREATE INDEX IF NOT EXISTS trip_plan_documents_document_idx
  ON trip_plan_documents (document_id);
