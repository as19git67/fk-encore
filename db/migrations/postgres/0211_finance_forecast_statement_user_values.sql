-- Retirement forecast: values of a statement corrected by hand.
--
-- The user can correct what was read from a statement (a misread amount or
-- date). Such a row is marked method = 'user', so the dialog can say so and
-- ask before reading the document again would overwrite the correction.
-- The kinds of 0210 get the same kind of check as the other enumerations.

ALTER TABLE finance_forecast_statement
  DROP CONSTRAINT finance_forecast_statement_method_check,
  ADD CONSTRAINT finance_forecast_statement_method_check CHECK (method IN ('regex', 'llm', 'user'));

ALTER TABLE finance_forecast_document_link
  ADD CONSTRAINT finance_forecast_document_link_doc_kind_check
    CHECK (doc_kind IN ('statement', 'dynamic_increase', 'dynamic_declined', 'other'));
