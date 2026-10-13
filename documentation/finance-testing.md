# Finance — Test Strategy

Goal: Define what gets tested in which module of the finance service,
which mocking pattern applies to external dependencies, and how the tests
fit into the existing Vitest setup of fk-encore.

Status: Feature plan, implemented per stage in parallel with the
respective implementation.

---

## 1. Tooling and conventions

Existing setup (see `vitest.config.ts`):

- **Vitest** as the runner; tests collocated as `*.test.ts`.
- **Postgres test DB** `encore_test` (connection string from
  `POSTGRES_TEST_CONNECTION_STRING`). No mocks for DB operations.
- **`fileParallelism: false`** — tests run sequentially; each test file
  may manipulate the schema as it likes.
- **`globalSetup`** and **`setupFiles`** provide migrations +
  base seeds; each test file cleans up what it needs itself via
  `DELETE FROM …` in `beforeEach`.
- **Encore endpoints are called as functions**, not over HTTP
  (see the Encore docs "Test an API endpoint" — a direct function call
  gives the same type safety as the generated client).

Convention for the new tests in the finance module: the same structure as
`documents/documents.test.ts` and `user/auth-handler.test.ts`.

---

## 2. Test matrix per module

Overview of what must be covered at minimum per file from
`finance-service-layout.md` §1.

### 2.1 `encryption.test.ts`

- Roundtrip: `decrypt(encrypt(x)) === x` for ASCII, UTF-8 (umlauts,
  emojis), empty string.
- Tampering: a forged auth tag → exception (`AES-GCM` error),
  no silent result.
- Wrong key (different secret) → exception.
- Format stability: two `encrypt` calls with the same plaintext
  yield different ciphertext blobs (IV randomness).
- Preparation for the rotation script: separate `encryptWithKey(key, x)` /
  `decryptWithKey(key, blob)` helpers enable re-encrypt tests
  without a process restart.

### 2.2 `fints-client.test.ts`

`lib-fints` itself is **not** touched in the unit test — we
mock the default export as a Vitest module mock at module level (so that
importing the wrapper does not try to instantiate real lib-fints classes).
The test-specific `FinTSClient` implementation
is then injected into `runSynchronize` via the `clientFactory` parameter
— so each individual test stays locally configurable.

- Mapping `success=true, requiresTan=false` → `state: "idle"`.
- Mapping `success=true, requiresTan=true` → `state: "tan-required"`
  with populated `tanChallenge`, `tanReference`, `tanMediaName` and
  `bankingInformation`.
- Mapping `success=false, bankAnswers=[{code:9910}]` → `state:
  "error"` with `errorCode: "9910"`.
- Multiple answers: with several `bankAnswers`, the first with
  `code !== 0` wins.
- Resume path: the wrapper calls `synchronizeWithTan(tanReference,
  tanAnswer)`, not `synchronize()`. `tanAnswer=undefined` is passed
  through transparently (decoupled TAN / pushTAN).
- Retry: a network exception is retried 2× (backoff 2 s / 4 s).
  On complete failure the wrapper returns `state: "error",
  errorCode: "transport"` — it throws **no** exception to the
  caller. Tests pass `sleep: async () => {}` instead of
  fake timers — no polling needed.
- Bank contact not found: `runSynchronize(unknownId, …)` throws
  a clear error (not `state: "error"`, because it is a caller error,
  not a dialog error).
- TAN method: if `finance_bankcontact.tan_method` is set,
  the wrapper calls `client.selectTanMethod(…)` on the first dialog
  with the parsed integer.

Integration test against real bank servers: **not** in the
test pipeline; manual before release against test accounts.

### 2.3 `tan-sessions.test.ts`

As in §2.4: all `complete` responses go through the shared
discriminated-union response. Error cases remain Encore `APIError`s
(real HTTP 4xx, no discriminator wrapper), because they are rejected before the call
to lib-fints.

- Happy path: mocked `fints-client.runSynchronize` returns
  `state: "idle"` → endpoint returns `{ state: "idle" }` and deletes
  the session.
- Wrong TAN: client again returns `state: "tan-required"` with a
  new challenge → endpoint **keeps the session** (`challenge` +
  `banking_information` updated), response
  `{ state: "tan-required", tanReference, challenge }`.
- Terminal error: client returns `state: "error"` → endpoint deletes
  the session, response
  `{ state: "error", errorCode, errorMessage }`.
- TTL behavior: reference whose `expires_at < now()` → `APIError
  .deadlineExceeded`; the record stays around, the cleanup cron removes
  it later.
- Decoupled TAN: `tan: undefined` is passed through transparently to
  `runSynchronize` (pushTAN flow).
- User isolation: caller A must not complete caller B's reference
  — the endpoint throws `not_found` (not `forbidden`),
  so that enumeration of other users' sessions is not possible.
- Permission: caller without `finance.accounts.manage` → 403, before the
  DB lookup.

In addition, `cleanupExpiredTanSessions` is tested: two rows
with staggered `expires_at`, only the expired one is deleted.

### 2.4 `statements.test.ts`

All sync responses are `200 OK` with a discriminated-union
response (`{ state: "idle" | "tan-required" | "error", ... }`) —
no HTTP 409.

- Sync trigger without TAN: mocked `fints-client.runSynchronize`
  returns `state: "idle"` → endpoint stores transactions (from
  stage 5), response `{ state: "idle" }`.
- Sync trigger with TAN: mocked client returns
  `state: "tan-required"` → endpoint persists
  `finance_tan_session` (own UUID as public handle, lib-fints'
  `tanReference` in `banking_information`), response
  `{ state: "tan-required", tanReference, challenge, tanMediaName? }`.
- Sync trigger with error: client returns `state: "error"` → response
  contains `errorCode` + `errorMessage`, **no** session row is
  created.
- Permission check: user without `finance.accounts.manage` gets 403
  before the client is even called.

### 2.5 `transactions.test.ts`

- ACL filter in `GET /finance/transactions`: a user with `level='read'`
  on account A sees only transactions of account A — test with
  3 accounts and 2 ACL entries.
- `level='write'` required for manual transactions: a user with only
  `read` ACL → 403 on `POST /finance/transactions`.
- Tag promotion: existing AI join + new user join in one
  transaction; idempotent if the user tag already exists.
- Batch tag: 50 selected transactions, "add only" vs.
  "replace" — check the number of `finance_tag_transaction` rows
  exactly.
- Duplicate protection: inserting twice with the same `dedupe_hash` →
  the second attempt returns `Conflict` from the unique index, without
  the DB transaction destroying everything before it.

### 2.6 `tags.test.ts` & `tag-suggester.test.ts`

- `tag-suggester`: mocked `llm-client.suggestTags` with a fixed
  response → correct persistence as `source='ai'` + `confidence`.
- AI suggestion with `confidence < 0.3` → discarded (no insert).
- AI suggestion whose tag name already exists as a user tag on the same
  transaction → no insert (avoid double confirmation).
- `tags.suggest` batch endpoint: runs over N transactions, writes
  suggestions isolated per transaction (an error aborts only that one
  transaction).

### 2.7 `analysis.test.ts`

- Parser mock: mocked `llm-client.parseAnalysisQuery` returns a
  known AST → SQL aggregator returns exact sums from a
  test fixture with 10 pre-created transactions.
- AND vs. OR on tags: same fixture, both operators, exact
  expected values.
- Date range filter: pin down and test `from`/`to` exclusive vs.
  inclusive.

### 2.8 `data-import.test.ts`

- Happy path: small JSON fixture (2 bank contacts, 3 accounts,
  20 transactions, 5 tags) → exact counts in the response.
- Re-import of the same JSON: all `skipped` counts match the
  original `counts`, no duplicates in the DB.
- Validation error: transaction references an unknown account →
  entry in `validationErrors`, but bank contacts and accounts are
  persisted nonetheless (stage isolation).
- Permission: `finance.view` user → 403 without side effect.

### 2.9 `account-access.test.ts`

- Diff saving: existing ACL `[A:read, B:write]`, new list
  `[A:write, C:read]` → exactly three DB operations (update A, delete B,
  insert C), not "first remove all, then re-add all".
- Permission: only `finance.admin`; test with `finance.accounts.manage`
  → 403.

### 2.10 `statements-cron.test.ts`

- Slot filter: `sync_times = [{weekdays:[1..5], time:"06:25",
  tz:"Europe/Berlin"}]`, `now()` is Wednesday 06:26 Berlin → tick
  fires; Wednesday 09:00 → tick does not fire.
- DST: `now()` is a summer-time date, slot 06:25 Berlin → correct
  UTC conversion (04:25 UTC, not 05:25). Test with an explicitly
  set date via `vi.setSystemTime`.
- Cleanup cron: three sessions with staggered `expires_at`, only the
  expired ones are deleted.

---

## 3. Mocking pattern

| External dependency | Strategy |
|---|---|
| `lib-fints` | `vi.mock("lib-fints", () => …)` at module level. The wrapper additionally offers a `clientFactory` test seam, so that individual tests can inject a tailor-made `FinTSClient` implementation without a second mock. |
| `llm-service` (`fetch`) | `vi.spyOn(globalThis, "fetch")` with a JSON response; tests check both the request body (prompt content) and the processing of the response. |
| `push.service` | direct mock of `notifyUser` from `push/push.ts`; tests check that the function was called with the correct `userId` and payload. |
| Drizzle / Postgres | **do not mock** — use the real test DB. |
| `getAuthData()` from `~encore/auth` | Reuse the helper `withAuthData(authData, fn)` from `user/auth-handler.test.ts`. |
| `secret(...)` from `encore.dev/config` | mocked globally in `vitest.setup.ts` (returns 32 null bytes base64). A test that checks real crypto uses `encryptWithKey` / `decryptWithKey` with an explicit key — not `encryptCredentials`. |
| Time (`Date.now`, timers) | `vi.useFakeTimers()` + `vi.setSystemTime(…)`; always reset in `afterEach`. Alternatively: functions that sleep accept a `sleep` test seam (like `runSynchronize`) — then `sleep: async () => {}` suffices. |

`fints-client.ts` itself is mocked in the endpoint tests, so that
those tests check pure endpoint logic — the real wrapper has its
own suite (§2.2).

---

## 4. Fixtures

One small, static fixture module per test area, **no**
faker/random data. Example structure:

```
finance/
├── fixtures/
│   ├── bankcontacts.fixture.ts
│   ├── accounts.fixture.ts
│   ├── transactions.fixture.ts
│   └── finanzkraft-export.fixture.ts
```

Fixtures are plain TypeScript objects that are loaded in `beforeEach` via
`db.insert(...).values(fixture).execute()`.
`finanzkraft-export.fixture.ts` is a deliberately small,
hand-curated JSON snippet of the real export format.

---

## 5. What we deliberately do not test

- **Real FinTS server**: lib-fints behavior against production banks
  runs as a manual smoke test before release, not in CI.
- **`lib-fints` itself**: is upstream's responsibility; bugs go there as
  an issue/PR.
- **`llm-service` response quality**: we test prompt construction and
  response parsing, not whether the LLM suggests "good" tags — that is
  a matter for model evaluation.
- **PrimeVue / Vue components**: no component tests in the MVP (no
  existing Vue test setup in the repo).
- **End-to-end / browser**: not part of this stage.

---

## 6. CI integration

The existing pipeline calls `npm test` (= Vitest). The new `*.test.ts`
files are picked up automatically — **no** change to
`vitest.config.ts` needed, as long as we stay with `finance/**.test.ts`
(matches `exclude` and the default include).

`encore test` runs in addition as soon as the migrations are committed;
in future it is the gold standard for endpoint tests, because it guarantees
Encore test DB isolation per test (see the Encore docs
"Test database setup"). In the MVP the existing `encore_test` DB
approach suffices.

---

## 7. References

| Location | Purpose |
|---|---|
| `vitest.config.ts` | Setup, test DB, `fileParallelism` |
| `documents/documents.test.ts` | Example style (imports, `describe`/`it`) |
| `user/auth-handler.test.ts` | `withAuthData` helper for permission tests |
| `finance-service-layout.md` §1 | List of files to test |

---

## 8. Open points

- **Should `encore test` be mandatory from stage 1**, or do we
  keep using `npm test` directly (Encore test DB isolation costs setup
  time per test)?
- **Coverage target** for the finance module: the repo currently has no
  coverage threshold; should we set e.g. 80% lines
  for `finance/**`?
- **Property-based tests** for `encryption.ts` (roundtrip over random
  inputs via `fast-check`) — added value or overkill?
