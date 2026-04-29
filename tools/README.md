# tools/

One-off scripts that aren't part of the running app — converters,
migrations, ad-hoc reports.

## `finanzkraft-to-fk-encore.ts`

Converts a Finanzkraft daily export (the JSON the as-express scheduler
writes every 8 h, see `dataExport.js` in `as19git67/finanzkraft`) into the
shape that fk-encore's `/finance/admin/import` endpoint expects.

### Workflow

1. Grab the latest `finanzkraft-…json` from your Finanzkraft data
   directory (or whatever path `EXPORTDATAFILE` points at).
2. Convert:

   ```sh
   npx tsx tools/finanzkraft-to-fk-encore.ts \
     < /path/to/finanzkraft-export.json \
     > /tmp/fk-encore-import.json
   ```

   The converter prints a one-line summary (`accounts=N transactions=M
   tags=K …`) on stderr; stdout is the import-ready JSON.

3. **Option A — Dropbox (empfohlen für große Exporte):**
   Benenne die Datei mit dem Suffix `.pending.json` und lege sie in
   das Verzeichnis, auf das `FINANCE_IMPORT_DIR` zeigt
   (Standard: `/data/finance-import`):

   ```sh
   cp /tmp/fk-encore-import.json \
      /data/finance-import/fk-encore-import.pending.json
   ```

   Der chokidar-Watcher erkennt die Datei automatisch, sobald ihre
   Größe für 5 Sekunden stabil bleibt (konfigurierbar via
   `FINANCE_IMPORT_STABILITY_MS`), und startet den Import ohne
   HTTP-Timeout. Nach Abschluss wird die Datei umbenannt:

   - Erfolg → `fk-encore-import.imported-<timestamp>.json`
   - Fehler  → `fk-encore-import.failed-<timestamp>.json`
              + `fk-encore-import.failed-<timestamp>.error.txt`

   Validierungsfehler einzelner Zeilen brechen den Import nicht ab;
   sie landen in einer Sibling-Datei
   `fk-encore-import.imported-<timestamp>.errors.json`.

   > **Hinweis:** Die Dropbox-Variante setzt immer `wipe_first=true`
   > (Dropbox-Semantik: „diese Datei IST der Finance-Stand"). Für
   > einen additiven Import ohne Wipe → Option B.

   **Option B — UI-Upload:**
   Öffne **Finanzen → Import**, wähle `/tmp/fk-encore-import.json`
   und starte den Import. Für einen iterativen Re-Run setze den
   Haken bei **"Vorher alle Finanzdaten löschen"**.

4. After import: open **Finanzen → Bankkontakte**. The pseudo-
   bankcontacts are already there — you only need to set the **real
   login + PIN** on each, pick a TAN-Verfahren, and the linked
   accounts come online. Cash wallets stay manual.

5. Open **Finanzen → Konto-Zugriff** and grant per-user read/write
   access for each account.

### What gets converted

| Finanzkraft entity | fk-encore target | Notes |
|---|---|---|
| `Accounts[].currency_id` + `currency_short` (and `Fk_Currency:id`/`:short` on transactions, plus `Fk_Transaction:originalCurrency`) | `currencies[]` (Stage 0) | Every ISO code seen in the export is upserted into `finance_currency` before any other stage runs, so transactions in CHF/GBP/JPY/… land cleanly without a manual seed. The matching `Fk_Currency:short` becomes the symbol; missing symbols fall back to the code. |
| `Accounts[].bankcontact_*` | `bankcontacts[]` (one row per `bankcontact_id`) | Pseudo-bankcontact: name + BLZ + server-URL come straight through, login is set to a placeholder `fk-bc-<id>`. The user fixes login+PIN+TAN-Verfahren in the new UI. |
| `Accounts[]` | `accounts[]` | Linked accounts get `bankcontact_blz/login` set to the matching pseudo-bankcontact; cash wallets stay manual. |
| `Accounts[].fintsAccountNumber` | `accounts[].fints_account_number` | Pre-fills the lib-fints accountNumber so a sync works the moment credentials are entered. |
| `Accounts[].account_type_id` | `accounts[].type_kind` | `cash`→`bargeld`, `checking`→`giro`, `credit`→`kreditkarte`, `daily`→`tagesgeld`, `savings`→`tagesgeld`, `security`→`depot`, `other`→`sonstige` |
| `Accounts[].closedAt !== null` | `accounts[].active = false` | |
| `Accounts[].number == null` | `accounts[].account_number = "fk-<id>"` | Synthetic key for cash wallets without a real account number. |
| `Transactions[].Fk_Transaction:bookingDate` (or fallback `valueDate`) | `transactions[].booking_date` | Pre-1999 records only have valueDate. |
| `Transactions[].Fk_Transaction:amount` | `transactions[].amount` | In account currency. Two decimals. |
| `Transactions[].Fk_Transaction:originalAmount/Currency/exchangeRate` | `transactions[].original_amount/original_currency_code/exchange_rate` | Multi-currency bookings keep the pre-conversion values for archival. |
| `Transactions[].Fk_Transaction:text` + `:notes` | `transactions[].purpose` | Joined with " / " when both present. |
| `Transactions[].Fk_Transaction:payee` | `transactions[].counterparty` | |
| `Transactions[].Fk_Transaction:IBAN` / `BIC` / `payeeBankId` | `transactions[].counterparty_iban` / `_bic` / `_bank_id` | |
| `Transactions[].Fk_Transaction:EREF` / `MREF` / `CRED` / `REF` | `transactions[].end_to_end_ref` / `mandate_ref` / `creditor_id` / `bank_ref` | SEPA references — proper columns, not `raw`. |
| `Transactions[].Fk_Transaction:ABWA` / `ABWE` | `transactions[].originator_name` / `recipient_name` | Abweichender Auftraggeber / Empfänger. |
| `Transactions[].Fk_Transaction:gvCode` / `entryText` / `primaNotaNo` | `transactions[].gv_code` / `entry_text` / `prima_nota_no` | MT940/FinTS metadata. |
| `Transactions[].Fk_Transaction:id` | `transactions[].fints_id = "fk-<id>"` | Used for tag-link cross-reference. |
| `Transactions[].Fk_Tags:tags` (pipe-separated) | global `tags[]` + `tag_links[]` | All tags imported with `source='user'`. |
| `Transactions[].Fk_Category:name` (or `:fullName` as fallback) | global `tags[]` + `tag_links[]` | Category name appended as an additional tag, unless it already appears in `Fk_Tags:tags`. |
| `Transactions[].Fk_Transaction:idCategory` / `Fk_Category:id` / `oldCategory` / `processed` | (dropped) | Internal IDs and the legacy hierarchy-string have no value outside Finanzkraft. `processed` is a Finanzkraft-internal workflow flag. |

### What gets dropped on purpose

- `Categories[]` — fk-encore classifies by tag only (see
  `docs/finance-tagging-and-ai.md`).
- `NewTransactionPresets[]` — preset suggestions are not part of fk-encore.
- `RuleSets[]` — rules are out of scope; tagging is manual + LLM.
- `SystemPreferences[]` / `Roles[]` / `Users[]` / `UserRoles[]` /
  `RolePermissionProfiles[]` — fk-encore has its own auth/role model.
- Per-account `reader[]` / `writer[]` ACL — fk-encore uses its own
  `finance_account_access` table; you set this per-account in the UI
  after import.

### Wiping the database before import

The Import-View has a checkbox **"Vorher alle Finanzdaten löschen"**.
With it enabled, the importer first runs a `TRUNCATE` over every
`finance_*` table (bankcontacts, accounts, transactions, tags, ACL,
balances, TAN sessions, embeddings) before applying the upload —
useful when iterating on mapping changes. Stammdaten (currencies,
account types, timespans, system prefs) survive the wipe. The button
turns red and asks for confirmation.

### Coverage summary

After every run the converter prints a field-coverage report on stderr,
e.g.:

```
[finanzkraft-converter] field coverage:
  Accounts (47 rows):
    first-class: account_type_id(47), currency_id(47), iban(34), id(47), …
    dropped    : balance(31), balanceDate(31), reader(15), writer(43), …
    unknown    : someBrandNewField(2)
    >>> 1 unknown field(s) — converter is missing a mapping! <<<
  Transactions (53428 rows):
    first-class: Fk_Transaction:amount(53428), …
    raw        : Fk_Transaction:CRED(8421), Fk_Transaction:MREF(8421), …
    dropped    : Fk_Account:id(53428), Fk_Currency:name(53428), …
```

- `first-class` = mapped 1:1 to a fk-encore column.
- `dropped` = deliberately not carried over (joined columns, ACL,
  balance history, categories, encrypted credentials, status flags).
- `unknown` = the converter has never heard of this attribute. If
  this list is non-empty, decide what to do with it (extend
  `ACCOUNT_FIELD_DISPOSITION` / `TRANSACTION_FIELDS_*` in the
  converter source) and re-run. Until then those values are simply
  dropped — the converter no longer maintains a catch-all `raw`
  bucket precisely so a new field gets noticed instead of silently
  surviving in the jsonb.

### Troubleshooting

- *"skipped N transactions (missing parent account or no usable date)"* —
  shows up on stderr when the converter sees a `Fk_Transaction` whose
  `idAccount` isn't in `Accounts[]` (Finanzkraft sometimes keeps
  orphaned tx rows for deleted accounts) or has neither
  `bookingDate` nor `valueDate`. These rows can't land anywhere
  meaningful, so the converter drops them. The import-side log will
  match.
- *"unknown type_kind"* on the import side means the Finanzkraft
  account had an `account_type_id` not in `TYPE_KIND_MAP`. Add the
  mapping to `tools/finanzkraft-to-fk-encore.ts` and re-run.
