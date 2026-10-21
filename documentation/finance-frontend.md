# Finance — Frontend: views, stores, wireframes

Goal: The finance module gets its own navigation section with 13 views in the Vue/PrimeVue
frontend of fk-encore. The legacy Finanzkraft
stack (Vue 3, PrimeVue, Pinia) matches 1:1, so views can be adopted
*in content* — the code, however, is rewritten against
the fk-encore API helper and the existing user store.

Dropped compared to legacy: `CategoriesView`, `TransactionRulesView`.
New compared to legacy: `AccountAssignmentView`, `SyncScheduleView`,
`AnalysisView`.

Status: Feature plan, implemented in stages.

Addendum: The implemented finance basket actions (`Split`, named
`Baskets`) are documented in
[`finance-basket-actions.md`](finance-basket-actions.md).

---

## 1. Stack and conventions

- **Vue 3.5** Composition API, `<script setup lang="ts">`.
- **PrimeVue 4.5** for UI components; the theme follows the existing
  fk-encore theme.
- **Pinia 3** for state, stores in `src/stores/finance/`.
- **Vue Router 4**, routes under `/finance/*`.
- **TypeScript strict**, interfaces for API responses from the
  generated Encore client.
- **API access**: via the existing fk-encore API helper (not
  axios, not a custom fetch wrapper).
- **Auth**: via the existing user store; no separate auth layer in the
  module. Permissions are queried via `useAuth().hasPermission("finance.view")`,
  in parallel with the backend checks.

---

## 2. Pinia stores

| Store | Purpose |
|---|---|
| `useAccountsStore` | List and detail cache, permissions-aware filter |
| `useTransactionsStore` | paginated list per account, tag filter, optimistic updates |
| `useBankcontactsStore` | Bank contacts including open TAN dialog state |
| `useTagsStore` | global tag list, separated by `source='user'` and `source='ai'` |
| `useSyncScheduleStore` | load/save `finance_bankcontact.sync_times` |
| `useFinancePrefsStore` | `finance_system_pref` (global settings) |

Each store holds its loading and error state; components call only
store actions, never the API helper directly.

**Note:** Depot holdings are *not* managed via a dedicated store,
but loaded on demand directly via `listHoldings(accountId)` from
the API helper. The data lives exclusively in the local state
of the `AccountDetailView` component.

---

## 3. Views

| View | Route | Permission | Purpose |
|---|---|---|---|
| `BankcontactsView` | `/finance/bankcontacts` | `finance.accounts.manage` | List + create |
| `BankcontactDetailView` | `/finance/bankcontacts/:id` | `finance.accounts.manage` | Edit, set credentials, sync trigger |
| `TanDialog` (modal) | — | `finance.accounts.manage` | TAN entry with countdown |
| `AccountsView` | `/finance/accounts` | `finance.view` | Account list (ACL-filtered) |
| `AccountDetailView` | `/finance/accounts/:id` | `finance.view` | Balance history, transactions |
| `AccountAssignmentView` | `/finance/admin/access` | `finance.admin` | User↔account ACL (new) |
| `TransactionsView` | `/finance/transactions` | `finance.view` | List + tag filter |
| `TransactionDetailView` | `/finance/transactions/:id` | `finance.view` | Edit, accept tag suggestions |
| `TransactionNewView` | `/finance/transactions/new` | `finance.view` | manual transaction |
| `BatchTagView` | `/finance/tags/batch` | `finance.view` | Multi-tagging on a selection |
| `SyncScheduleView` | `/finance/bankcontacts/:id/schedule` | `finance.accounts.manage` | UI cron per bank contact (new) |
| `AnalysisView` | `/finance/analysis` | `finance.view` | Natural-language queries (new) |

Router guards check the respective permission and redirect to the dashboard root
if authorization is missing — analogous to the existing
Photos/Documents routes.

---

## 4. Wireframes

### 4.1 `TanDialog`

Is overlaid as a PrimeVue dialog on every view that triggers a sync.
The countdown binds against `expires_at` from the TAN session.

```
+---------------------------------------------+
| TAN required — Sparkasse XY                 |
+---------------------------------------------+
| Challenge:                                  |
|   Please confirm the login                  |
|   in the pushTAN app of your Sparkasse.     |
|                                             |
| TAN:  [ _ _ _ _ _ _ ]                       |
|                                             |
| Valid for:  09:42                           |
|                                             |
|                     [Cancel]  [Confirm]     |
+---------------------------------------------+
```

Flow (see `finance-fints-integration.md` §4): when
`POST /finance/statements` responds with `{ state: "tan-required" }`,
the UI opens the dialog with `tanReference` and `challenge`; submit
calls `POST /finance/tan-sessions/complete`, which returns the same
discriminated-union response (on success `state: "idle"`,
on a wrong TAN `state: "tan-required"` again with a new challenge).

### 4.2 `AnalysisView`

> **Removed (2026-10):** the analysis page (`AnalysisView`, `finance/analysis.ts`,
> saved analyses and their daily suggestions) is gone. Sums with subtotals by tag
> or period now come from rule-based Sammelmappen the assistant creates
> (`create_transaction_folder`) and from `POST /finance/transactions/totals`.


```
+--------------------------------------------------------+
| Analysis                                               |
+--------------------------------------------------------+
| Question:  [ Was habe ich im Italien-Urlaub 2024 … ] 🔍 |
+--------------------------------------------------------+
| Detected:                                              |
|   Tags:      [urlaub ✕] [italien-2024 ✕]  + add         |
|   Operator:  (•) AND   ( ) OR                          |
|   Period:    [2024-06-01] — [2024-09-30]               |
|                                    [Refresh]           |
+--------------------------------------------------------+
| Total:     2.341,50 €   Count: 47   Avg:  49,82 €      |
|                                                        |
| [ Monthly bar chart (PrimeVue Chart)                ]  |
|                                                        |
| Top counterparties:                                    |
|   Trattoria Da Luigi      412,00 €   (14 transactions) |
|   Hotel Firenze           890,00 €   ( 3 transactions) |
|   Trenitalia              234,00 €   ( 8 transactions) |
|                                                        |
|                     [Export as CSV (optional)]         |
+--------------------------------------------------------+
```

(The sample question reads in English: "What did I spend on the 2024 Italy vacation …".)

AST chips are editable — the user can remove/add tags, toggle the
operator, adjust the period, then click "Refresh". Only the
initial parse calls the `llm-service`; edits run purely as
SQL against the backend.

### 4.3 `SyncScheduleView`

```
+--------------------------------------------------------+
| Sync times — Sparkasse XY                              |
+--------------------------------------------------------+
| Time zone:  [ Europe/Berlin ▾ ]                        |
|                                                        |
| Slots:                                                 |
|   Mo Tu We Th Fr      06:25   [Remove]                 |
|   Mo Tu We Th Fr      15:25   [Remove]                 |
|   Sa                  08:00   [Remove]                 |
|                                                        |
|   + Add slot                                           |
|     Weekdays:  [ ]Mo [ ]Tu … [ ]Su                     |
|     Time:      [ 08:00 ]                               |
|     [Add]                                              |
|                                                        |
|                       [Cancel]  [Save]                 |
+--------------------------------------------------------+
```

Saving writes `finance_bankcontact.sync_times` as a JSON array (see
`finance-data-model.md` §2.3). The UI shows the next effective
run relative to `now()` in the current time zone — including
DST adjustment.

### 4.4 `AccountAssignmentView`

```
+--------------------------------------------------------+
| Account access  (finance.admin only)                   |
+--------------------------------------------------------+
| Account:  [ DE12 … 3456  Checking Sparkasse XY  ▾ ]    |
+--------------------------------------------------------+
| Authorized users:                                      |
|   Alice Müller     [ read  ▾ ]   [Remove]              |
|   Bob Schmidt      [ write ▾ ]   [Remove]              |
|                                                        |
|   + Add user:                                          |
|     [ Search user …          ]   [ read ▾ ]   [+]      |
|                                                        |
|                                      [Save]            |
+--------------------------------------------------------+
```

Writes to `finance_account_access`. The dropdown for users draws from
the existing user endpoint (no separate finance user list).
Existing rows of the selected account are computed before saving as
a diff against the new list (inserts / deletes / level updates).

### 4.5 `BankcontactsView`

Entry list for users with `finance.accounts.manage`.

```
+-----------------------------------------------------------------------+
| Bank contacts                                    [+ Create new]       |
+-----------------------------------------------------------------------+
| Name            BLZ       Login            Last sync          Status  |
|-----------------------------------------------------------------------|
| Sparkasse XY    12345678  max.mustermann   2026-04-23 06:25   ✓ OK    |
| ING             50010517  123456789        2026-04-22 15:25   ⚠ TAN   |
| DKB             12030000  98765432         —                  ⛔ Error |
+-----------------------------------------------------------------------+
| Filter: [ Status: All ▾ ]       Click row → detail view               |
+-----------------------------------------------------------------------+
```

Status column: `last_sync_status` (`OK`, `tan-required`, `error`) plus
a matching icon. The row color signals problems (yellow for
`tan-required`, red for `error`). Clicking opens `BankcontactDetailView`.

### 4.6 `BankcontactDetailView`

Form view for master data, credentials and sync actions. Divided
into three clearly separated card areas.

```
+-----------------------------------------------------------------------+
| Bank contact: Sparkasse XY                             [Back]         |
+-----------------------------------------------------------------------+
| Master data                                                           |
|   Name:         [ Sparkasse XY                             ]          |
|   BLZ:          [ 12345678 ]                                          |
|   Login:        [ max.mustermann                           ]          |
|   Server URL:   [ https://hbci.sparkasse-xy.de             ]          |
|   TAN method:   [ pushTAN ▾ ]      [Reload TAN methods]               |
+-----------------------------------------------------------------------+
| Credentials                                                           |
|   Password/PIN: [ ············ ]   [Set new]                          |
|   Status: ✓ stored encrypted  (last 2026-04-23)                       |
+-----------------------------------------------------------------------+
| Sync                                                                  |
|   Last sync:  2026-04-23 06:25 — OK, 3 transactions                   |
|   [Sync now]            [Edit sync times]                             |
+-----------------------------------------------------------------------+
|                           [Cancel]              [Save]                |
+-----------------------------------------------------------------------+
```

- The `Passwort/PIN` (password/PIN) input sends the plaintext exclusively to the
  set-credentials endpoint, which uses `encryption.ts` (see
  `finance-fints-integration.md` §3); only the
  boolean "status stored" flag remains in the store.
- `Sync jetzt` (Sync now) calls `POST /finance/statements`; if the response is
  `{ state: "tan-required", ... }`, the `TanDialog` opens (§4.1).
- `Sync-Zeiten bearbeiten` (Edit sync times) navigates to `SyncScheduleView` (§4.3) for
  the same bank contact.
- `TAN-Methoden neu laden` (Reload TAN methods) starts a short FinTS dialog only to
  read the available methods and updates the dropdown.

### 4.7 `AccountsView`

The only view that every `finance.view` user sees. ACL-filtered:
only accounts on which the user has a `finance_account_access` entry
(or all, if they hold `finance.admin`).

```
+-----------------------------------------------------------------------+
| Accounts                                   [ Bank contact: All ▾ ]    |
+-----------------------------------------------------------------------+
| Label             IBAN              Curr.  Balance      Last txn      |
|-----------------------------------------------------------------------|
| Giro Sparkasse    DE12 … 3456       EUR     2.341,50 €  2026-04-22    |
| Tagesgeld ING     DE50 … 0517       EUR    12.000,00 €  2026-04-15    |
| Depot DKB         DE12 … 0000       EUR    45.678,90 €  2026-04-10    |
+-----------------------------------------------------------------------+
| Show inactive accounts: [ ]       Click row → AccountDetailView       |
+-----------------------------------------------------------------------+
```

The current balance comes from the latest entry in
`finance_account_balance`. No inline editing — all changes go
through `AccountDetailView` or `AccountAssignmentView`.

### 4.8 `AccountDetailView`

Split in two: balance history on top, transaction list below (using the same
component as `TransactionsView`, with the account preselected).

```
+----------------------------------------------------------------------+
| Giro Sparkasse XY — DE12 … 3456                           [Back]     |
+----------------------------------------------------------------------+
| Current balance: 2.341,50 €      As of: 2026-04-22 06:25             |
|                                                                      |
| [ Balance history (PrimeVue Line Chart, 12 months)                ]  |
|                                                                      |
+----------------------------------------------------------------------+
| Transactions                 [Filter ▾]   [+ Manual transaction]     |
|----------------------------------------------------------------------|
| Date        Purpose            Counterparty    Amount       Tags     |
| 2026-04-22  Miete April        B. Vermieter    -850,00 €    [miete]  |
| 2026-04-20  Supermarkt         REWE              -47,32 €   [alltag] |
| 2026-04-15  Gehalt April       AG GmbH        +3.800,00 €   [gehalt] |
+----------------------------------------------------------------------+
| Period:  [ 12 months ▾ ]              Page 1 of 14    < 1 2 3 >      |
+----------------------------------------------------------------------+
```

- The balance chart period dropdown reuses the `finance_timespan` presets (see
  `finance-data-model.md` §2.2).
- `+ Manuelle Buchung` (+ Manual transaction) opens `TransactionNewView` with a preselected
  account — only visible if the user holds `level='write'` on the account.
- Clicking a row leads to `TransactionDetailView`.

#### Depot view

For depot accounts (`type_kind === 'depot'`), the
`AccountTransactionsView` switches to a depot-optimized layout:

- **Holdings table** ("Positionen", positions) is shown instead of the transaction list.
  Columns: name/ISIN, quantity (amount), price (price), value
  (value), optional cost basis (cost_basis), gain/loss (unrealized_gain),
  realized (realized_gain), share (share %). A footer row shows
  the total value ("Gesamt", total) and 100 %.
  - Cost basis/gain-loss/realized are hidden entirely if no
    position has a value for them (`show*Column` computeds in
    `AccountTransactionsView.vue`). Below 640px, cost basis and realized
    additionally drop out (in addition to the already existing dropping of
    share) — on narrow displays name/qty/price/value/gain-loss remain
    (#887). Each expanded position shows all values nonetheless in
    a narrow key-figures row (`holdings-facts`) below the chart.
- **Value history chart** (total value over time) and the
  position sparkline in the expanded state use compact
  x-axis labels from `utils/financeChartDates.ts`: day+month within
  one calendar year, month/short year for at most one data point per
  month over several years, otherwise day+month+short year. The full date
  appears in the tooltip title (#887).
- **Transaction toolbar** (filter, batch select, batch tag buttons) is
  hidden — depot accounts have no classic transactions.
- The **"Keine Buchungen vorhanden"** (no transactions available) message is suppressed — the
  holdings table handles its own empty state ("Keine
  Positionen vorhanden", no positions available).
- **Transaction loading is skipped** for depot accounts, to avoid an
  unnecessary DB query.

Holdings are loaded via `GET /finance/accounts/:id/holdings` and
displayed in a `<table>`. The latest `as_of` date appears in
the section heading.

Depot detection uses `resolvedAccount.value?.type_kind === 'depot'`
from the overview store.

```
+----------------------------------------------------------------------+
| Depot DKB — 1234567800                                      [Back]   |
+----------------------------------------------------------------------+
| Current value: 45.678,90 €      As of: 2026-05-13                    |
+----------------------------------------------------------------------+
| Positions (13.05.2026)                                                |
|----------------------------------------------------------------------|
| Name / ISIN              Qty      Price       Value        Share     |
| ADIDAS AG                10      215,40 €    2.154,00 €    4,7 %     |
|   DE000A1EWWW0                                                       |
| ISHARES CORE MSCI WO.    150      75,20 €   11.280,00 €   24,7 %     |
|   IE00B4L5Y983                                                       |
| …                                                                    |
|----------------------------------------------------------------------|
| Total                                       45.678,90 €   100 %      |
+----------------------------------------------------------------------+
```

### 4.9 `TransactionsView`

Main working view. DataTable with virtual scroll, filter bar,
multi-select for batch actions.

```
+-----------------------------------------------------------------------+
| Transactions                       [ Period: 30 days ▾ ]  [Export]    |
+-----------------------------------------------------------------------+
| Filter:                                                               |
|   Account:     [ All ▾ ]         Tags: [urlaub ✕] [+]                 |
|   Amount:      [ min ] — [ max ]  Counterparty: [ Search …        ]   |
|                          [Apply filter]   [Clear]                     |
+-----------------------------------------------------------------------+
| [x] Select all (47)                  [Apply tags to selection]        |
|-----------------------------------------------------------------------|
| [x] Date        Account     Counterparty     Purpose        Amount    |
| [x] 2024-08-12  Giro SpaXY  Hotel Firenze    Übernachtung  -340,00 €  |
|                                                           [urlaub] [italien-2024] |
| [ ] 2024-08-11  Giro SpaXY  Trattoria Luigi  Mittagessen    -47,30 €  |
|                                                           [urlaub] [italien-2024] |
| [x] 2024-08-10  Giro SpaXY  Trenitalia       Zug Rom-Flo.   -89,00 €  |
|                                                           [urlaub] [italien-2024] |
+-----------------------------------------------------------------------+
| Selection total: -476,30 €        Page 1 of 3    < 1 2 3 >            |
+-----------------------------------------------------------------------+
```

Clicking a row opens `TransactionDetailView` (§4.10). "Tags auf Auswahl
anwenden" (apply tags to selection) opens `BatchTagView` (§4.12). "Export" delivers a CSV of the
currently filtered list (optional MVP feature).

### 4.10 `TransactionDetailView`

Detail view with tag editor. AI suggestions and user tags are visually
clearly separated.

```
+-----------------------------------------------------------------------+
| Transaction #421876                                         [Back]    |
+-----------------------------------------------------------------------+
| Booking date:    2024-08-12     Value date:    2024-08-12             |
| Account:         Giro Sparkasse XY (DE12 … 3456)                      |
| Counterparty:    Hotel Firenze                                        |
|                  IT12 A 07601 03200 000012345678                      |
| Purpose:                                                              |
|   Übernachtung 09.–12.08.2024, Doppelzimmer                           |
| Amount:         -340,00 €                                             |
+-----------------------------------------------------------------------+
| Tags                                                                  |
|   User:   [urlaub ✕]  [italien-2024 ✕]  [hotel ✕]  [+ Tag]            |
|                                                                       |
|   AI suggestions:                                                     |
|     ◌ restaurant     ▰▱▱▱▱  0.34   [✓ accept]  [✕ discard]            |
|     ◌ reise          ▰▰▰▰▱  0.62   [✓ accept]  [✕ discard]            |
|                                                                       |
|   Accepted → becomes user tag (blue chip above).                      |
+-----------------------------------------------------------------------+
|                                                    [Save]            |
+-----------------------------------------------------------------------+
```

User tags are blue chips with `✕` remove; AI suggestions are gray
chips with a confidence bar. "Übernehmen" (accept) performs exactly the promotion
behavior from `finance-tagging-and-ai.md` §2 (delete AI join,
create user join, `confidence = NULL`).

### 4.11 `TransactionNewView`

Form for manual transactions. Reachable only if the user holds
`level='write'` on at least one account.

```
+-----------------------------------------------------------------------+
| New transaction                                             [Back]    |
+-----------------------------------------------------------------------+
| Account *:           [ Giro Sparkasse XY ▾ ]                          |
| Booking date *:      [ 2026-04-23 ]                                   |
| Value date:          [            ]   (optional)                      |
| Amount *:            [        0,00 ]  EUR                             |
|                      ( ) Income      (•) Expense                      |
| Counterparty:        [                                       ]        |
| Counterparty IBAN:   [                                       ]        |
| Purpose *:           [                                       ]        |
|                      [                                       ]        |
| Tags:                [+ Add tag]                                      |
+-----------------------------------------------------------------------+
|                            [Cancel]               [Book]              |
+-----------------------------------------------------------------------+
```

Required fields are marked with `*`. The account dropdown shows only
accounts with `finance_account_access.level = 'write'` for the
logged-in user (or all, if `finance.admin`).

### 4.12 `BatchTagView`

Is opened from `TransactionsView` as a PrimeVue dialog as soon as at
least one row is selected and "Tags auf Auswahl anwenden" (apply tags to selection)
is clicked.

```
+-----------------------------------------------------------------------+
| Apply tags to selection                                               |
+-----------------------------------------------------------------------+
| Selection:                                                            |
|   12 transactions                                                     |
|   Period: 2024-08-10 — 2024-08-18                                     |
|   Total:  -876,45 €                                                   |
+-----------------------------------------------------------------------+
| Add tags:                                                             |
|   [urlaub ▾]  [italien-2024 ▾]   [+ another tag]                      |
|                                                                       |
| Remove tags (optional):                                               |
|   [alltag ▾]                                                          |
|                                                                       |
| Mode:  (•) Add only   ( ) Replace existing                            |
+-----------------------------------------------------------------------+
|                          [Cancel]               [Apply]               |
+-----------------------------------------------------------------------+
```

"Replace existing" removes all existing user tags of the selection before
adding — explicitly behind a radio button, so that
nobody accidentally overwrites existing tags.


---

## 5. Interaction specifics

- **TAN flow**: The `useBankcontactsStore` action `syncNow(id)`
  switches on `response.state`: on `"tan-required"` it opens the
  `TanDialog` and blocks further sync triggers for this bank contact
  until `complete` or cancel. Push notifications (from the cron, see
  `finance-fints-integration.md` §5.1) lead in the foreground tab
  automatically to a store refresh, so that the user sees the dialog right away.
- **AI tag promotion**: `TransactionDetailView` sends, on click on
  an AI chip, `POST /finance/transactions/:id/tags/promote` with the
  tag name. The store updates optimistically; rollback on error.
- **Analysis**: `AnalysisView` sends the free-text question only on the
  initial parse; edits to the AST trigger a pure aggregation call
  (`POST /finance/analysis/aggregate`), without querying the LLM again.
- **Permissions UI consistency**: menu items and buttons are wrapped behind
  `hasPermission(...)`, but final enforcement lies
  in the backend (`requirePermission(...)` in every handler).

---

## 6. References

| Location | Purpose |
|---|---|
| existing Photos/Documents views | API helper usage, store pattern |
| `finance-fints-integration.md` §4 | `TanDialog` backend contract |
| `finance-tagging-and-ai.md` §3–§4 | AI chips, `AnalysisView` backend |
| `finance-data-import.md` | Import backend (dropbox) |
| `finance-data-model.md` §5 | Permissions for router guards |

---

## 7. Open points

- **CSV export in `AnalysisView`**: really MVP or only later?
- **Diff preview in `AccountAssignmentView`**: do we need a
  confirmation view ("+ Alice read, − Bob, Charlie read→write")
  before saving?
- **Push in the foreground tab**: should we automatically open the `TanDialog` when a TAN
  push notification arrives, or only show
  a subtle hint in the menu?
- **Balance chart period**: default 12 months? Or coupled to `finance_timespan`?
