-- Retirement forecast: what kind of document a linked document is.
--
-- Besides statements, insurers send announcements of premium increases
-- (Dynamik) and confirmations that an increase was declined. The kind
-- decides which premium counts: after a declined increase, the premium a
-- statement or an announcement states is not proposed. It is recognised
-- when the document is read; kind_by_user marks a kind the user set, which
-- reading again never overrides.

ALTER TABLE finance_forecast_document_link
  ADD COLUMN doc_kind TEXT NOT NULL DEFAULT 'statement',
  ADD COLUMN kind_by_user BOOLEAN NOT NULL DEFAULT false;
