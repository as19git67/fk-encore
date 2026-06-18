-- PayPal OAuth state for the Authorization-Code flow (Issue #427, Etappe 5).
--
-- The `state` query parameter PayPal echoes back on the callback has to
-- be unguessable + scoped to the bankcontact that started the flow, so
-- a stolen URL can't connect a different user's bankcontact. We mint
-- a random 32-byte token per `paypal/start` call, persist it here, and
-- look it up on `paypal/callback` to:
--   1. verify the callback isn't forged (state token must match),
--   2. recover which bankcontact this code belongs to,
--   3. enforce a short TTL — old state rows can't be replayed.
--
-- Rows are deleted on successful exchange and aged out by the daily
-- finance-tan-cleanup job (which already cleans tan-session leftovers).

CREATE TABLE IF NOT EXISTS finance_paypal_oauth_state (
    state            text PRIMARY KEY,
    bankcontact_id   integer NOT NULL
                     REFERENCES finance_bankcontact(id) ON DELETE CASCADE,
    user_id          integer NOT NULL
                     REFERENCES users(id) ON DELETE CASCADE,
    environment      text NOT NULL,
    created_at       timestamp with time zone NOT NULL DEFAULT now(),
    expires_at       timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_finance_paypal_oauth_state_expires
    ON finance_paypal_oauth_state (expires_at);
