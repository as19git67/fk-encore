# Finance — Rate Limiting & Brute-Force Protection

Goal: Define which Finance endpoints must be protected, which limits are
appropriate, and how this is implemented with the existing rate limiter from
`user/rateLimiter.ts` — without any new infrastructure.

Status: feature plan, implemented together with the respective endpoints from
`finance-roadmap.md`.

---

## 1. Starting point in the repo

`user/rateLimiter.ts` provides:

- `getClientIp()` — reads `X-Forwarded-For` or `X-Real-IP` from the
  Encore request (via `currentRequest()`).
- `checkRateLimit(key)` — sliding-window counter (10 attempts / 15 min),
  throws `APIError` with HTTP 429 when exceeded.
- `resetRateLimit(key)` — for successful operations (counterpart).
- Storage: **in-memory map**, per process. The limit is therefore bound to
  a single instance process; with a multi-instance deployment this is
  irrelevant for the current auth endpoints (single-instance
  production) — note in the file comment: possibly migrate to Encore Cache
  (Redis).

Users so far: `user/auth.service.ts` (login), `user/passkey.ts`
(passkey attempts). **No** other service currently limits.

Decision for Finance: **reuse the existing rate limiter**,
do not build a new one. Keys are chosen so that the auth limits and
Finance limits count independently.

---

## 2. Which endpoints are limited

Only endpoints with a real abuse/DoS risk are restricted;
pure read endpoints remain unlimited (they sit behind `finance.view`
and the ACL).

| Endpoint | Method | Limit | Key | Rationale |
|---|---|---|---|---|
| `/finance/tan-sessions/complete` | POST | 5 / 10 min | `tan-complete:<tan_reference>` | The FinTS server limits itself (usually 3 TAN attempts), but we want to prevent an attacker from brute-forcing third parties' TAN references as long as they have not expired. The key is **per reference**, not per IP — three users behind NAT must not lock each other out. |
| `/finance/bankcontacts/:id/credentials` | POST | 10 / 15 min | `bank-creds:<userId>:<bankcontactId>` | Curb the credential-set rate — prevents a compromised user account from trying an arbitrary number of credential changes (noise in the log + CPU for crypto). |
| `/finance/statements` | POST | 20 / 15 min | `sync-trigger:<userId>:<bankcontactId>` | Manual sync trigger: limited per user×bank contact so that nobody accidentally (or maliciously) floods the bank with HBCI dialogs. The cron runs on its own anyway. |
| `/finance/admin/import` | POST | 3 / 60 min | `finance-import:<userId>` | The import is expensive (minutes, large DB transactions). Three attempts per hour are more than the admin actually needs. |
| `/finance/analysis/query` | POST | 30 / 10 min | `analysis-query:<userId>` | The LLM call during parsing costs compute time of the `llm-service`. Edit-based re-aggregates (`/finance/analysis/aggregate`) do **not** count, because they do not call an LLM. |
| `/finance/tags/suggest` | POST | 5 / 60 min | `tag-suggest-batch:<userId>` | The batch endpoint runs over many transactions → many LLM calls. Limit strictly. |

Not limited (but documenting why):

| Endpoint | Reason |
|---|---|
| `GET /finance/accounts`, `/finance/transactions`, `/finance/tags` | Pure reads, ACL-filtered, no incentive for abuse. |
| `POST /finance/transactions` (manual transaction) | Writes exactly one row; abuse would at most be DB noise, not DoS. |
| `POST /finance/transactions/:id/tags/promote` | Cheap operation, only within the user's own ACL. |
| `POST /finance/analysis/aggregate` | Pure SQL aggregation, no LLM call. |

---

## 3. Integration in handler code

Same pattern as in `user/auth.service.ts`. Example for
`tan-sessions.complete`:

```ts
import { checkRateLimit, resetRateLimit, getClientIp } from
  "../user/rateLimiter";

export const complete = api(
  { expose: true, method: "POST", path: "/finance/tan-sessions/complete" },
  async (req: CompleteReq): Promise<CompleteRes> => {
    const auth = getAuthData()!;
    await requirePermission(auth, "finance.accounts.manage");

    const key = `tan-complete:${req.tanReference}`;
    checkRateLimit(key, { maxAttempts: 5, windowMs: 10 * 60_000 });

    const result = await finishTanDialog(req.tanReference, req.tan);
    if (result.state === "idle") {
      resetRateLimit(key);      // success: reset the counter
    }
    return { imported: result.imported ?? 0 };
  },
);
```

The existing `checkRateLimit(ip)` from `user/rateLimiter.ts` gets a second
parameter `{ maxAttempts, windowMs }` in this stage,
so that not every endpoint inherits the default limits (10 / 15 min).

### 3.1 Signature extension

Currently:
```ts
export function checkRateLimit(ip: string): void
```

Extension (backward compatible):
```ts
interface RateLimitOpts {
  maxAttempts?: number;   // default: 10
  windowMs?: number;      // default: 15 * 60 * 1000
}
export function checkRateLimit(key: string, opts?: RateLimitOpts): void
```

Renaming the parameter `ip` → `key` makes it visible that
Finance keys are not IPs. The existing caller in
`user/auth.service.ts` continues to pass `getClientIp()` — behavior
identical.

---

## 4. Frontend behavior on 429

The frontend stores catch HTTP 429 and show a
`PrimeVue.Toast` message:

> "Zu viele Versuche — bitte {remainingSeconds}s warten." (Too many attempts — please wait {remainingSeconds}s.)

The `Retry-After` header is set by `checkRateLimit`
(addition to the existing helper: the current `resetAt - now()`
difference in seconds). The stores read the header and set a
countdown state, which the UI shows, e.g. in the `TanDialog`, as a disabled
button with a timer.

---

## 5. Push rate limiting (link to `finance-logging-monitoring.md`)

The push rate limits mentioned in §3.2 of the logging document (TAN:
max. 1× / 30 min per bank contact; failed sync: max. 1× / 6 h) do
**not** go through `checkRateLimit` — that is not endpoint protection
but notification dedupe. Implementation in `statements-cron.ts`:

```ts
// Simple DB-backed dedupe row
CREATE TABLE finance_push_dedupe (
  scope      TEXT NOT NULL,       -- "tan-required" | "sync-failed"
  entity_id  INTEGER NOT NULL,    -- bankcontact_id
  last_sent  TIMESTAMP NOT NULL,
  PRIMARY KEY (scope, entity_id)
);
```

The cron checks before `notifyUser(...)`:

```ts
const lastSent = await db.queryRow<{ last_sent: string }>`
  SELECT last_sent FROM finance_push_dedupe
  WHERE scope = ${scope} AND entity_id = ${bankcontactId}`;
if (lastSent && Date.now() - Date.parse(lastSent.last_sent) < windowMs) {
  return;  // still cooling down
}
// send + upsert last_sent
```

The table belongs in a follow-up migration (e.g. `0045_finance_push_dedupe.sql`)
and is not part of the initial migration from stage 1.

---

## 6. What we deliberately do not do

- **No IP-based limiting on Finance endpoints** — users often sit
  behind NAT, and the endpoints are all `auth: true` (no
  IP brute force conceivable without a valid session cookie). Limits apply
  per user or per resource.
- **No captcha / reCAPTCHA** — the auth layer already protects the entry point,
  and Finance endpoints are never public.
- **No Redis migration in the MVP** — the project runs as a single
  instance. If it has to scale later, the rate limiter is, according to the
  comment in `user/rateLimiter.ts`, the first candidate
  for Encore Cache (Redis) anyway.
- **No per-route config file** — limits are written in the respective
  handler as a literal next to the call; this keeps the configuration local
  to its context.

---

## 7. Tests (supplement to `finance-testing.md`)

At least three tests per limited endpoint:

1. **Normal use**: 3 calls within the window → all
   succeed.
2. **Exceeding**: `maxAttempts + 1` rapid calls → the last
   throws `APIError` 429.
3. **Reset after success**: a call that triggers `resetRateLimit(key)`
   sets the counter to 0 — afterwards `maxAttempts` attempts are free again.

Vitest setup: `vi.useFakeTimers()`, so that the window can be
simulated without `sleep`. The in-memory map is cleared per test in
`beforeEach` via a newly to-be-created helper
`__resetRateLimiterForTests()` (export from
`user/rateLimiter.ts`, used only in tests).

---

## 8. Open points

- **Limit tuning**: the numbers in §2 are estimates; after three months
  of production operation, compare against log statistics and adjust if necessary.
- **`finance_push_dedupe` table vs. in-memory**: for a single instance
  in-memory suffices, but the DB variant survives restarts. Recommendation:
  DB variant (see §5).
- **Retry-After header**: `checkRateLimit` must learn to set it actively —
  the existing code only throws `APIError`, without a header. Small
  addition in `user/rateLimiter.ts`, not in Finance.
- **`resetRateLimit` on partial success**: TAN complete with
  `state: "tan-required"` (follow-up TAN) — does that count as success (reset)
  or as an attempt? Proposal: count it as success, because the user is on
  the right path.
