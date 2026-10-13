# Finance — Logging & Monitoring

Goal: Define what is logged in the Finance module, how the user
gets to see failure states (UI + push), and how the admin finds them in
live operation.

Status: feature plan, implemented in parallel with the respective stage from
`finance-roadmap.md`.

---

## 1. Starting point in the repo

- **Prevailing pattern**: `console.log` / `console.error` with a
  prefix in square brackets (`[boot] …`, `[documents] …`) — see
  `documents/encore.service.ts` and `documents/inbox-cron.ts`.
- **Structured logging** via `encore.dev/log` exists, but is used
  only in `backup/` and `realtime/`.
- **No** Prometheus metrics, no Sentry, no APM. Monitoring runs
  via logs + DB columns that the UI displays.

Decision for Finance: **the same pattern as `documents/`** —
`console.log`/`console.error` with the prefix `[finance] …` or
`[finance.<submodule>] …`. Structured logging is a nice-to-have,
not an MVP must.

---

## 2. Log events per module

### 2.1 Sync cron (`statements-cron.ts`)

**One info line** per tick, not per bank contact — otherwise the
log becomes unreadable with many contacts.

```
[finance.cron] sync tick: contacts=5 dueForSlot=2
[finance.cron] sync done: ok=2 tanRequired=0 errored=0 (duration=1842ms)
```

Per bank contact **only on change** (TAN needed or error):

```
[finance.cron] bankcontact=3 (Sparkasse XY) → tan-required, push sent
[finance.cron] bankcontact=7 (ING) → error: 9910 wrong-pin
```

The result is additionally persisted in `finance_bankcontact.last_sync_at`
and `finance_bankcontact.last_sync_status` (string enum: `ok`,
`tan-required`, `error:<code>`). This is the source for the UI badge
in `BankcontactsView` (see `finance-frontend.md` §4.5).

### 2.2 TAN flow (`statements.ts`, `tan-sessions.ts`)

```
[finance.tan] session created: ref=<uuid> bankcontact=3 user=42 expires=2026-04-23T15:35:00Z
[finance.tan] session completed: ref=<uuid> imported=17 balances=1
[finance.tan] session failed: ref=<uuid> reason=wrong-tan attempt=2/3
[finance.tan] session expired (deleted by cleanup): ref=<uuid>
```

UUIDs are logged in full — they are one-time values and contain no
secrets. Neither the TAN value nor the `banking_information` payload ends up
in the log.

### 2.3 Credential crypto (`encryption.ts`)

Log **errors only** — a successful round trip is noise.

```
[finance.crypto] decrypt failed for bankcontact=3: auth-tag mismatch
```

Important: never log either the key or the blob. Tests ensure this
(spy on `console.error`).

### 2.4 AI pipeline (`tag-suggester.ts`, `llm-client.ts`)

```
[finance.ai] suggest tags: tx=421876 neighbors=20 suggested=3 accepted=2
[finance.ai] llm-service unavailable: retries-exhausted, skipping tx=421876
```

Errors do not block the insert — the suggestion is simply missing.
`LlmServiceUnavailableError` (from the existing pattern) is
caught and logged as a warning.

### 2.5 Data import (`data-import.ts`)

Stage by stage, so that progress is visible in the log:

```
[finance.import] job=<uuid> start: user=1 file=finanzkraft-2026-04.json size=2.4MB
[finance.import] job=<uuid> stage=bankcontacts: inserted=5 skipped=0 errors=0
[finance.import] job=<uuid> stage=accounts: inserted=12 skipped=0 errors=0
[finance.import] job=<uuid> stage=transactions: inserted=48710 skipped=2 errors=0
[finance.import] job=<uuid> done: duration=187s validationErrors=2
```

### 2.6 Analysis (`analysis.ts`)

Only the **question hash + AST shape**, never the raw question (it may contain
personal information such as names of illnesses).

```
[finance.analysis] parsed: hash=<sha256-8> tags=2 op=AND timespan=92d
```

---

## 3. Visibility for the user

### 3.1 UI displays

| Where | Source | Meaning |
|---|---|---|
| `BankcontactsView` status column | `last_sync_status` | ✓ OK / ⚠ TAN / ⛔ Fehler (error) (yellow/red row) |
| `BankcontactDetailView` sync box | `last_sync_status` + `last_sync_at` | "Letzter Sync: 2026-04-23 06:25 — OK, 3 Umsätze" (last sync: …, 3 transactions) or an error message |
| Main navigation | Count of the user's open `finance_tan_session` | Badge on the "Finance" menu item |
| `AdminImportView` | SSE/polling on `/finance/admin/import/:jobId/status` | Live progress per stage |

### 3.2 Push notifications

Sent via `push.service.notifyUser(userId, ...)`. The user is the
owner of the bank contact (determined from `finance_account_access.level =
'write'`; falls back to the first write user if there are several):

| Event | Title | Body |
|---|---|---|
| Sync cron reports `tan-required` | "TAN erforderlich — {Bank}" (TAN required) | "Bitte im Browser bestätigen." (Please confirm in the browser.) |
| N-th failed sync in a row (N=3) | "Sync fehlgeschlagen — {Bank}" (Sync failed) | "Letzter Fehler: {Code}. Bitte Credentials prüfen." (Last error: {code}. Please check credentials.) |

**Rate limit**: TAN push at most once every 30 min per bank contact,
failed-sync push once every 6 h — otherwise the cron annoys the user. See
`finance-rate-limiting.md` (follows as the next doc) for details.

---

## 4. Visibility for the admin

### 4.1 Log grep recipes

```bash
# All cron ticks of the last hour
grep '\[finance.cron\]' logs/encore.log | tail -60

# Failed syncs counted per bank contact
grep '\[finance.cron\].*→ error' logs/encore.log \
  | awk '{print $3}' | sort | uniq -c

# Running import jobs
grep '\[finance.import\]' logs/encore.log | grep -v 'done:'

# TAN sessions that expired in the last 24 h
grep '\[finance.tan\] session expired' logs/encore.log
```

### 4.2 DB health queries

```sql
-- Bank contacts that have not synced successfully for > 24 h
SELECT id, name, last_sync_at, last_sync_status
FROM finance_bankcontact
WHERE last_sync_status <> 'ok'
   OR last_sync_at < now() - interval '24 hours';

-- Number of TAN sessions (indicator for UI getting stuck)
SELECT count(*) FROM finance_tan_session
WHERE expires_at > now();

-- AI suggestions that have been left unprocessed for more than 30 days
SELECT count(*) FROM finance_tag_transaction tt
JOIN finance_tag t ON t.id = tt.tag_id
WHERE t.source = 'ai' AND tt.created_at < now() - interval '30 days';
```

These queries can later optionally be bundled into a small admin dashboard view
(`FinanceHealthView`) — not MVP, but cheap.

---

## 5. What we deliberately do not do

- **No external telemetry** (Sentry, Datadog) — the project is
  self-hosted, logs suffice.
- **No structured-logging mandate** — `encore.dev/log` may be used,
  but is not required. Only the prefix pattern is important, so that
  `grep` works consistently.
- **No alerting pipeline** — the user is informed via push,
  the admin finds problems via the DB column `last_sync_status`
  or via log grep. A dedicated alerting channel (Slack/email)
  can come later as a separate stage.
- **No log redaction as a framework** — instead discipline in the
  tests: every new file gets a test that checks that certain
  fields (`credentials_encrypted`, TAN value, `banking_information`)
  never end up in `console.error`/`console.log` calls.

---

## 6. Open points

- **Log rotation**: who truncates `logs/encore.log`? Currently
  apparently not regulated. Finance will not increase the volume
  drastically, but given the planned push noise (TAN events)
  the admin should check this once.
- **`encore.dev/log` as a requirement** for new modules — team decision
  pending. Pragmatically `console.*` suffices for now.
- **Retention for AI suggestions**: should unprocessed `source='ai'`
  joins be deleted automatically after 90 days? The DB query for this is
  already sketched in §4.2.
- **Admin dashboard**: separate view or in `BankcontactsView` as an
  "Alles anzeigen" (show all) toggle for `finance.admin`?
