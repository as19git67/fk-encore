-- Retirement forecast: premium invoices and policies as kinds of linked documents.
--
-- Property and supplementary insurances send no statements; their figures
-- come from the Beitrags-/Prämienrechnung and the Versicherungsschein (or a
-- Nachtrag to it). Both now count as documents with values, like a
-- statement.

ALTER TABLE finance_forecast_document_link
  DROP CONSTRAINT finance_forecast_document_link_doc_kind_check,
  ADD CONSTRAINT finance_forecast_document_link_doc_kind_check
    CHECK (doc_kind IN ('statement', 'dynamic_increase', 'dynamic_declined', 'premium_invoice', 'policy', 'other'));
