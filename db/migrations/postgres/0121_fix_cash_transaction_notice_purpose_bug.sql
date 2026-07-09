-- Data fix: the manual cash-booking form ("Bargeldbuchung anlegen") bound
-- its "Notiz" input to the `purpose` field instead of `notice`, so every
-- note typed there ended up stored as Verwendungszweck. Move that
-- mis-stored text to the front of any existing notice and clear purpose,
-- for cash-account ("bargeld") transactions only.
--
-- Receipt-OCR auto-booked cash transactions are excluded: those legitimately
-- use `purpose` for the item list and `notice` for the structured receipt
-- text (see finance/receipt-booking.ts). They are identified via the
-- `documents.receipt_transaction_id` anchor set on successful auto-booking.
--
-- `fat.kind::text = 'bargeld'` (rather than comparing the enum column
-- directly) avoids Postgres' "unsafe use of new value" error: on a fresh
-- database all migrations run inside one transaction, and 'bargeld' was
-- added to finance_account_kind via ALTER TYPE ... ADD VALUE in migration
-- 0054 — a new enum value cannot be referenced before that ADD VALUE
-- commits, but casting the column to text sidesteps constructing an enum
-- literal entirely.
UPDATE finance_transaction ft
SET
  notice = CASE
    WHEN ft.notice IS NULL OR length(trim(ft.notice)) = 0 THEN ft.purpose
    ELSE ft.purpose || E'\n\n' || ft.notice
  END,
  purpose = NULL
FROM finance_account fa
JOIN finance_account_type fat ON fat.id = fa.type_id
WHERE ft.account_id = fa.id
  AND fat.kind::text = 'bargeld'
  AND ft.purpose IS NOT NULL
  AND length(trim(ft.purpose)) > 0
  AND NOT EXISTS (
    SELECT 1 FROM documents d WHERE d.receipt_transaction_id = ft.id
  );
