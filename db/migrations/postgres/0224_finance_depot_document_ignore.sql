-- Documents the user marked as irrelevant to the depots (#1336).
--
-- "Belege einlesen" and the review page read every settlement-looking
-- document that is not yet linked to a depot transaction. Some of them
-- never will be — a letter that merely mentions a fund, a statement for a
-- depot that is not connected. Marking one here keeps it out of both; the
-- document itself stays untouched in the document management. Removing
-- the row brings it back.
CREATE TABLE finance_depot_document_ignore (
  document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  ignored_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
