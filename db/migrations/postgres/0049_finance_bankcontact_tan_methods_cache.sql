-- Cache the bank-advertised TAN-method list on the bankcontact so
-- the UI picker stays populated across page reloads without a fresh
-- FinTS probe. Nullable; an empty / NULL cache means "user has not
-- probed yet — show the 'Abrufen'-button hint".

ALTER TABLE finance_bankcontact
    ADD COLUMN available_tan_methods JSONB;
