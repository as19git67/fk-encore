-- Allow the same fints_account_number to appear more than once per
-- bankcontact when the accounts have different types (e.g. giro +
-- depot share the same bank-side account number at many German banks).
-- The old unique constraint on (bankcontact_id, fints_account_number)
-- would reject the second link.  Replace it with a triple that
-- includes type_id.

ALTER TABLE finance_account
  DROP CONSTRAINT IF EXISTS finance_account_unique_bank_link;

CREATE UNIQUE INDEX finance_account_unique_bank_link
  ON finance_account (bankcontact_id, fints_account_number, type_id);
