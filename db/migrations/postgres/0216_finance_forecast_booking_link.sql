-- Retirement forecast: bookings that pay a contract item's premium.
--
-- A premium that is paid shows up as a booking. A booking is linked to an
-- item when it names the contract number (purpose or SEPA mandate
-- reference), when it is already linked to one of the item's documents, or
-- - as a suggestion to confirm - when its counterparty names the insurer
-- and its amount fits the premium. The confirmed bookings give the real
-- rhythm and amount, which the forecast offers as a correction.

CREATE TABLE finance_forecast_booking_link (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES finance_forecast_item(id) ON DELETE CASCADE,
  transaction_id BIGINT NOT NULL REFERENCES finance_transaction(id) ON DELETE CASCADE,
  match_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  CONSTRAINT finance_forecast_booking_link_kind_check CHECK (match_kind IN ('contract', 'document', 'counterparty', 'user')),
  CONSTRAINT finance_forecast_booking_link_status_check CHECK (status IN ('suggested', 'confirmed', 'rejected'))
);

CREATE UNIQUE INDEX finance_forecast_booking_link_unique ON finance_forecast_booking_link (item_id, transaction_id);
CREATE INDEX idx_finance_forecast_booking_link_transaction ON finance_forecast_booking_link (transaction_id);
