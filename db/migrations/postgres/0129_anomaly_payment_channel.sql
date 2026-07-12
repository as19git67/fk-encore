-- Migration 0129: Payment channel on recurring mandates.
--
-- The anomaly detector groups transactions into recurring mandates by
-- counterparty identity (mandate_ref → IBAN → name). This misgroups
-- transactions of different types to the same counterparty — e.g. a
-- monthly SEPA direct debit ("Lastschrift") and a one-off card payment
-- ("Kartenzahlung") to DB Vertrieb both land in the same mandate,
-- causing false-positive amount_change alerts.
--
-- Adding a payment_channel column lets the detector keep separate
-- mandates per counterparty + channel. Existing mandates get NULL
-- (= legacy) and are matched loosely until they are re-processed.
--
-- The unique partial indexes on (account_id, counterparty_iban) and
-- (account_id, counterparty) are replaced by versions that include
-- payment_channel via COALESCE so that legacy NULL rows still
-- participate in uniqueness.

ALTER TABLE finance_recurring_mandate
  ADD COLUMN payment_channel TEXT;--> statement-breakpoint

-- Replace the iban and name uniqueness indexes to include payment_channel.
-- Tier 1 (mandate_ref + creditor_id) is already specific enough —
-- payment_channel is redundant there.
DROP INDEX uq_mandate_iban;--> statement-breakpoint
DROP INDEX uq_mandate_name;--> statement-breakpoint

CREATE UNIQUE INDEX uq_mandate_iban
  ON finance_recurring_mandate (account_id, counterparty_iban, COALESCE(payment_channel, ''))
  WHERE mandate_ref IS NULL AND creditor_id IS NULL AND counterparty_iban IS NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX uq_mandate_name
  ON finance_recurring_mandate (account_id, counterparty, COALESCE(payment_channel, ''))
  WHERE mandate_ref IS NULL AND creditor_id IS NULL AND counterparty_iban IS NULL AND counterparty IS NOT NULL;
