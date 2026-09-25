-- Retirement forecast: statements as the source of contract values (#1343).
--
-- After the one-time spreadsheet import, the values of contract items (life
-- insurance, private and company pensions, the statutory pension) are
-- updated only from the insurers' statements in the documents module. Two
-- tables carry that:
--
-- finance_forecast_document_link — which documents belong to which item.
-- Found by contract number: first through the reference tags the documents
-- pipeline already writes (versicherungsnr:…, vertragsnr:…), else through
-- the document text. A tag match is confirmed right away, a text match is a
-- suggestion the user confirms or rejects.
--
-- finance_forecast_statement — what a statement says (surrender value,
-- payouts, pension, premium, dates) and what the user did with it. One row
-- per item and document, so reading a statement again replaces its values
-- instead of piling up. Accepted rows are the item's history over the years.

CREATE TABLE finance_forecast_document_link (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES finance_forecast_item(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  match_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  CONSTRAINT finance_forecast_document_link_kind_check CHECK (match_kind IN ('tag', 'text', 'user')),
  CONSTRAINT finance_forecast_document_link_status_check CHECK (status IN ('suggested', 'confirmed', 'rejected'))
);
CREATE UNIQUE INDEX finance_forecast_document_link_unique ON finance_forecast_document_link (item_id, document_id);
CREATE INDEX idx_finance_forecast_document_link_document ON finance_forecast_document_link (document_id);

CREATE TABLE finance_forecast_statement (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES finance_forecast_item(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  reference_date DATE,
  "values" JSONB NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  CONSTRAINT finance_forecast_statement_method_check CHECK (method IN ('regex', 'llm')),
  CONSTRAINT finance_forecast_statement_status_check CHECK (status IN ('proposed', 'accepted', 'rejected', 'no_change'))
);
CREATE UNIQUE INDEX finance_forecast_statement_unique ON finance_forecast_statement (item_id, document_id);
CREATE INDEX idx_finance_forecast_statement_item ON finance_forecast_statement (item_id, reference_date);
