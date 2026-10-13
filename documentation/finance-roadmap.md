# Finance — Stage Roadmap

Order and scope of the implementation steps after completion of stage 0
(architecture documentation). Each stage names its deliverable,
the guiding architecture doc, test focus, and dependencies.

Status: feature plan, implementation starts with stage 1.

---

## 0. Overview

| # | Title | Guiding doc | MVP? |
|---|---|---|---|
| 0 | Architecture documentation | all 7 docs | ✓ (completed) |
| 1 | DB schema + migration | `finance-data-model.md` | ✓ |
| 2 | Credential crypto + FinTS client | `finance-fints-integration.md` §1–§3 | ✓ |
| 3 | Bank contacts CRUD + TAN flow | `finance-fints-integration.md` §4 + `finance-frontend.md` §4.1/§4.5/§4.6 | ✓ |
| 4 | Accounts + ACL | `finance-data-model.md` §5 + `finance-frontend.md` §4.4/§4.7/§4.8 | ✓ |
| 5 | Transactions + AI tagging | `finance-tagging-and-ai.md` §3 + `finance-frontend.md` §4.9–§4.12 | ✓ |
| 6 | Sync cron + push | `finance-fints-integration.md` §5 + `finance-frontend.md` §4.3 | ✓ |
| 7 | Data import | `finance-data-import.md` + `finance-frontend.md` §4.13 | ✓ |
| 8 | Overall frontend picture | `finance-frontend.md` §1–§5 | ✓ |
| 9 | Analysis queries | `finance-tagging-and-ai.md` §4 + `finance-frontend.md` §4.2 | post-MVP |

MVP = stages 1–8. Stage 9 follows after the MVP.

---

## 1. Stage 1 — DB schema + migration

**Goal**: Migration `0043_finance_initial.sql` ready for production use,
Drizzle schema importable, permissions seeded.

**New files**:
- `db/migrations/postgres/0043_finance_initial.sql` (Drizzle-generated)
- Addition in `db/schema.ts` (all tables + enums from
  `finance-data-model.md` §2)
- Addition in `db/seed.ts` (4 new permissions + admin exclusion)

**Tests**: schema consistency (`drizzle-kit check`), migration round trip
against a fresh `encore_test` DB.

**Dependencies**: none.

---

## 2. Stage 2 — Credential crypto + FinTS client

**Goal**: Store credentials encrypted, integrate `lib-fints`,
`runSynchronize` as a testable function.

**New files**:
- `finance/encore.service.ts`, `finance/types.ts`
- `finance/encryption.ts` + `.test.ts`
- `finance/fints-client.ts` + `.test.ts`
- `package.json` extended with `lib-fints`
- `vitest.setup.ts` extended with a mock for `encore.dev/config`,
  so that modules that instantiate secrets on import do not fail
  in tests because of the missing Encore runtime
- Three Encore secrets set locally + in CI:
  - `FinanceCredentialsKey` — 32 bytes base64, AES-256-GCM key
  - `FinanceFintsProductId` — ZKA-registered product ID (dummy
    is fine locally, mandatory in prod)
  - `FinanceFintsProductVersion` — semantic version number of the
    Finance module

**Tests**: round trip + tampering (§2.1), FinTS wrapper logic with
mocked `lib-fints` (§2.2 from `finance-testing.md`).

**Dependencies**: stage 1 (schema present, but no endpoints needed
yet).

---

## 3. Stage 3 — Bank contacts CRUD + TAN flow

**Goal**: A user can create a bank contact, set credentials,
manually trigger a sync, and confirm the TAN. Still without cron.

**New files**:
- `finance/bankcontacts.ts` + `.test.ts`
- `finance/statements.ts` + `.test.ts` (for now only the manual trigger)
- `finance/tan-sessions.ts` + `.test.ts`
- Frontend: `BankcontactsView`, `BankcontactDetailView`, `TanDialog` +
  `useBankcontactsStore`

**Tests**: happy-path TAN flow end-to-end with a mocked FinTS client
(§2.3/§2.4), session TTL, wrong-TAN path.

**Dependencies**: stage 2.

---

## 4. Stage 4 — Accounts + ACL

**Goal**: Accounts readable for authorized users; admin can grant
access rights.

**New files**:
- `finance/accounts.ts` + `.test.ts`
- `finance/account-access.ts` + `.test.ts`
- Frontend: `AccountsView`, `AccountDetailView`,
  `AccountAssignmentView` + `useAccountsStore`

**Tests**: ACL filter in GET endpoints (§2.5), diff saving in
`account-access` (§2.9).

**Dependencies**: stage 3 (bank contacts provide the FK for accounts).

---

## 5. Stage 5 — Transactions + AI tagging

**Goal**: Transactions are persisted during sync, AI suggestions
are created on insert, the user can accept/discard/manually
add to them.

**New files**:
- `finance/transactions.ts` + `.test.ts`
- `finance/tags.ts` + `.test.ts`
- `finance/tag-suggester.ts` + `.test.ts`
- `finance/llm-client.ts`
- Embedding table as migration `0044_finance_embeddings.sql`
  (see `finance-tagging-and-ai.md` §3.2)
- Frontend: `TransactionsView`, `TransactionDetailView`,
  `TransactionNewView`, `BatchTagView` + `useTransactionsStore`,
  `useTagsStore`

**Tests**: tag promotion, confidence threshold, dedupe unique conflict
(§2.5/§2.6).

**Dependencies**: stage 4 (accounts present), `llm-service` running.

---

## 6. Stage 6 — Sync cron + push

**Goal**: Bank contacts are synchronized automatically according to configured
time slots; push when a TAN is needed.

**New files**:
- `finance/statements-cron.ts` + `.test.ts`
- `finance/sync-schedule.ts` (CRUD for `finance_bankcontact.sync_times`)
- Frontend: `SyncScheduleView` + `useSyncScheduleStore`

**Tests**: slot filter with fake timer, DST correctness, cleanup cron
(§2.10).

**Dependencies**: stages 3+5 (statements and transactions path
live), `push.service` available (existing).

---

## 7. Stage 7 — Data import

**Goal**: Admin can upload the Finanzkraft export as JSON; the import
runs idempotently, ACL is set manually afterwards.

**New files**:
- `finance/data-import.ts` + `.test.ts`
- `finance/import-schema.ts` (Zod schema)
- `finance/fixtures/finanzkraft-export.fixture.ts`
- Frontend: `AdminImportView`

**Tests**: happy path, re-import idempotency, validation errors per
stage (§2.8).

**Dependencies**: stages 3–5 (all target tables must have endpoints
with write logic, so that the import can use the same validation path).

---

## 8. Stage 8 — Overall frontend picture

**Goal**: Navigation entry, permission guards, dashboard tile,
global layout for all Finance routes.

**New files**:
- Route registration in `frontend/src/router.ts`
- Menu entry in the main navigation (behind `module.finance`)
- Optional: Finance dashboard widget with next sync time and
  TAN badge counter

**Tests**: manual smoke test in the browser (no component test setup
in the repo).

**Dependencies**: stages 3–7 (all views have their backends).

**MVP completion after this stage.**

---

## 9. Stage 9 — Analysis queries (post-MVP)

**Goal**: `AnalysisView` usable; natural-language questions are translated into
tag-filter ASTs and aggregated.

**New files**:
- `finance/analysis.ts` + `.test.ts` (parser + aggregator)
- Frontend: `AnalysisView` + store extension

**Tests**: parser against examples, SQL aggregation with fixture
transactions (§2.7).

**Dependencies**: MVP (stages 1–8).

---

## 10. Parallelizability and team size

With a single person: strictly sequential, as above.

With two parallel streams:
- Stream A (backend): 1 → 2 → 3 → 4 → 5 → 6 → 7
- Stream B (frontend): waits for stage 3, then runs in parallel to 4+5+6+7:
  bank contact/account/transaction/schedule views.
- From stage 5, stream B can build the UI against a mock backend if
  stream A lags behind.

---

## 11. References

| Location | Purpose |
|---|---|
| `finance-data-model.md` | Stages 1, 4, 5 (DB + ACL) |
| `finance-fints-integration.md` | Stages 2, 3, 6, 10 |
| `finance-tagging-and-ai.md` | Stages 5, 9 |
| `finance-data-import.md` | Stage 7 |
| `finance-frontend.md` | Stages 3–9 (UI work) |
| `finance-service-layout.md` | every stage (target files) |
| `finance-testing.md` | every stage (test focus) |
