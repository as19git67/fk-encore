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

3. Open **Finanzen → Import** in the fk-encore UI, pick
   `/tmp/fk-encore-import.json`, and start the import.

4. After import: open **Finanzen → Bankkontakte**, create the real
   bankcontacts (BLZ, login, server-URL, PIN, TAN-Verfahren). Then on
   each imported account go to its detail page and link it to the
   matching bankcontact via IBAN.

5. Open **Finanzen → Konto-Zugriff** and grant per-user read/write
   access for each account.

### What gets converted

| Finanzkraft entity | fk-encore target | Notes |
|---|---|---|
| `Accounts[]` | `accounts[]` | Always imported as **manual** (no bankcontact link). User wires them up later. |
| `Accounts[].account_type_id` | `accounts[].type_kind` | `cash`→`bargeld`, `checking`→`giro`, `credit`→`kreditkarte`, `daily`→`tagesgeld`, `savings`→`tagesgeld`, `security`→`depot`, `other`→`sonstige` |
| `Accounts[].closedAt !== null` | `accounts[].active = false` | |
| `Accounts[].number == null` | `accounts[].account_number = "fk-<id>"` | Synthetic key for cash wallets without a real account number. |
| `Transactions[].Fk_Transaction:bookingDate` (or fallback `valueDate`) | `transactions[].booking_date` | Pre-1999 records only have valueDate. |
| `Transactions[].Fk_Transaction:amount` | `transactions[].amount` | Already in account currency, two decimals. |
| `Transactions[].Fk_Transaction:text` + `:notes` | `transactions[].purpose` | Joined with " / " when both present. |
| `Transactions[].Fk_Transaction:payee` | `transactions[].counterparty` | |
| `Transactions[].Fk_Transaction:IBAN` | `transactions[].counterparty_iban` | Falls back to `payeePayerAcctNo`. |
| `Transactions[].Fk_Transaction:id` | `transactions[].fints_id = "fk-<id>"` | Used for tag-link cross-reference. |
| `Transactions[].Fk_Tags:tags` (pipe-separated) | global `tags[]` + `tag_links[]` | All tags imported with `source='user'`. |
| every `Fk_Transaction:*` field | `transactions[].raw` | Full archival (CRED/MREF/REF, original currency, exchange rate, etc.). |

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
- `raw` = archived in `transactions[].raw` (jsonb) — not lost, but
  not query-able from the UI either.
- `dropped` = deliberately not carried over (joined columns, ACL,
  balance history that the import schema doesn't yet support).
- `unknown` = the converter has never heard of this attribute. If
  this list is non-empty, decide what to do with it (extend
  `ACCOUNT_FIELD_DISPOSITION` / `TRANSACTION_FIELDS_*` in the
  converter source) and re-run. Until then those values are simply
  skipped.

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
