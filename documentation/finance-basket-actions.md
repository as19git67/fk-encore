# Finance — Basket Actions

Status: implemented in Epic #722.

This document describes the extended actions in the Finance basket. The
basket is the temporary selection of transactions in the Finance UI.

---

## UI behavior

The basket actions are offered in the `TxBasketIndicator` drawer. Actions
that load data before displaying it (`Baskets`) open their
dialog immediately and load the contents afterwards. Errors are shown in the
respective dialog so that a click does not appear "dead".

On narrow viewports the actions are arranged compactly so that the
transaction list is not pushed out entirely.

### Live sync with the transaction list

Basket actions that change transaction fields (review note, tax relevance,
counterparty unification, tags, notice) write the result back not only to the
basket store but also mirror it into the currently displayed list via
`useTransactionsStore.syncFrom()` / `.patch()`. This way the list shows the
change immediately, without the user having to reload (#886).

`syncFrom`/`patch` are no-ops for IDs that are not on the currently loaded
page — so a change to a transaction outside the active filter/scope does not
sneak into the list by accident.
`TransactionDetailView.save()` follows the same pattern for single edits.

The batch notice action is a special case: `POST
/finance/transactions/batch-notice` returns only counters, no updated
transactions. The frontend therefore replicates the server's replace/append
rule locally (`BatchNoticeDialog` passes text + mode along in the `applied`
event) instead of reloading the transactions.

---

## Split

`Split` logically divides a single bank transaction into several parts. The
action lives in the transaction detail view (`SplitTransactionDialog`),
no longer in the basket: a split always concerns exactly one transaction.

The original transaction remains unchanged in `finance_transaction`. The
split is stored as an overlay in `finance_transaction_split`:

- `transaction_id`: reference to the original transaction, `ON DELETE CASCADE`
- `amount`: partial amount
- `tags`: JSON array of tag names
- `notice`: optional notice per part
- `is_tax_relevant`: tax-relevant flag per part

On save, existing split rows of this transaction are replaced completely.
The sum of all parts must match the amount of the original transaction to the
cent.

API:

- `GET /finance/transaction-splits?id=…`
- `PUT /finance/transaction-splits?id=…`

The older typed endpoints remain compatible on the backend:

- `GET /finance/transactions/:transactionId/splits`
- `PUT /finance/transactions/:transactionId/splits`

The frontend uses the raw JSON endpoints with a static path, analogous to
the basket snapshot endpoints. This avoids browser/runtime problems
with path-param pattern decoding and typed API encoding.

Amounts are entered in the dialog without a sign; the sign of the original
transaction is applied on save. Decimal and thousands separators
follow the UI locale (`utils/financeSplit.ts`).

---

## Tax relevance

There are two independent flags:

- `finance_transaction.is_tax_relevant` — the transaction as a whole. Can be
  set via the basket action `Steuerrelevant` (tax relevant)
  (`POST /finance/transactions/batch-tax-relevant`) or individually via the
  toggle in the detail view, which calls the same endpoint with one ID.
- `finance_transaction_split.is_tax_relevant` — per partial amount, set in the
  split dialog.

`GET /finance/transactions` filters via `taxRelevant`:

- `taxRelevant=true` → transactions that are marked themselves **or**
  have at least one marked partial amount
- `taxRelevant=false` → transactions to which neither applies
- omitted → no filter

So that the filtered list remains recognizable, each transaction additionally
returns `has_tax_relevant_split`; the list accordingly shows "Steuerrelevant"
(tax relevant) or "Teilbetrag steuerrelevant" (partial amount tax relevant).

---

## Named baskets

`Baskets` stores the current transaction selection under a name. A saved
basket can later be loaded, deleted, or compared with another
basket.

Persistence lives in `finance_basket_snapshot`:

- `user_id`: owner of the saved basket
- `name`: name, unique per user
- `tx_ids`: array of the transaction IDs

On load, transactions that are no longer accessible or have been deleted are
skipped; the response contains `missing`.

Frontend paths deliberately use raw JSON endpoints with static paths,
to avoid problems with typed API encoding/decoding and browser pattern errors:

- `GET /finance/basket-snapshots`
- `POST /finance/basket-snapshots`
- `GET /finance/basket-snapshot?id=…`
- `DELETE /finance/basket-snapshot?id=…`

The older typed endpoints remain compatible on the backend:

- `GET /finance/baskets`
- `POST /finance/baskets`
- `GET /finance/baskets/:id`
- `DELETE /finance/baskets/:id`

All basket responses are normalized as JSON-safe DTOs, in particular
`BIGINT` fields such as `id` and `tx_ids`.
