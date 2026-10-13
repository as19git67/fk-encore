# AI Queue: Push Wakeup Instead of Per-Second Polling

Status: **Implemented** — `ai-queue/waiters.ts`, `ai-queue/api.ts`,
`ai-queue/slot-helper.ts` including tests
(`ai-queue/waiters.test.ts`, `ai-queue/slot-helper.test.ts`, extended
`ai-queue/api.test.ts`).

## Problem

`ai-queue` serializes access to the external AI services (llm,
embedding, insightface) via the `ai_model_slot` table: exactly one
`active` slot per model, all further requests wait in priority order.

Waiting is polling today: in the waiting state, `withAiSlot()` (in
`ai-queue/slot-helper.ts`) calls `pollSlot` every second
(`AI_QUEUE_POLL_INTERVAL_MS`, default 1000 ms). Each poll costs two SQL
queries (status + position calculation). Under contention —
e.g. photo-embedding, photo-quality, documents-scan and finance-tagging
at the same time on `llm`/`embedding` — this produces permanent, useless
DB traffic even though the state usually does not change.

## Core Idea

**When releasing, the slot holder wakes up the next waiter directly,
instead of all waiters polling.**

A key simplification compared to a full dispatcher inversion ("ai-queue
calls back the app service, which dispatches the next job"): the dreaded
chain problem — *"when the queue is empty, there is no future trigger
anymore; new items would have to restart the chain"* — does not exist at
all in the current structure if only the **waiting** is made push-based:

- `acquireSlot` checks **atomically** on enqueue whether a slot is free
  and activates immediately (`INSERT` + conditional `UPDATE`). The
  acquire call itself is therefore always the "initial trigger" — an
  empty queue needs no re-priming.
- `releaseSlot` already promotes the next waiter in the DB today
  (`waiting` → `active`). Only the notification of the waiting caller is
  missing — and that is exactly what replaces the polling.

The services' job queues (photo scan-queue, documents scan-queue,
finance tag-queue) stay unchanged: each worker still dequeues on its own
and schedules its competing queues itself (concurrency, backpressure,
service health, backup pause). Only the waiting phase in `withAiSlot`
becomes event-driven.

### Why Not a Full Inversion?

The variant "ai-queue calls a callback endpoint of the app service when
a slot is free, which then dequeues the next job" was deliberately
rejected:

1. **State is spread across two systems.** The worker already holds the
   job dequeued while it waits for the slot; with inversion the job would
   either have to be put back or the job selection moved into the
   ai-queue.
2. **Scheduling preconditions would have to be duplicated.** Before the
   dequeue, the workers check event-loop pressure, service health,
   backup pause, etc. A callback from the ai-queue would have to re-check
   all of that and, on "doesn't fit right now", pass the slot on —
   additional error paths.
3. **The re-priming problem would only arise through this** (empty queue
   → no trigger → app service has to feed in an "initial item"). With the
   wakeup approach, the acquire semantics remain self-triggering.

The wakeup design achieves the same goal (no polling, immediate slot
handover) with a fraction of the rework.

## Constraint: Process Topology

All Encore TS services run self-hosted as **one** Node process (one
`fk-encore` container, see `docker-compose.yml`); they share one Postgres
DB via a common pool (`db/database.ts`). This makes an **in-process
waiter registry** (module singleton) work: `ai-queue/api.ts` (wakes) and
`ai-queue/slot-helper.ts` (waits) see the same registry instance.

Should the topology ever be split across several processes, the fallback
poll (see below) kicks in — the system then degrades to slow polling
instead of hanging. Phase 2 (optional, only if needed): Postgres
`LISTEN/NOTIFY` as a cross-process wakeup channel.

## Design

### 1. New Module `ai-queue/waiters.ts` (In-Process Registry)

```ts
// Map slotId → resolve function of the waiting promise
const waiters = new Map<number, () => void>();

/** Registers a waiter. Resolved by wakeWaiter(slotId). */
export function registerWaiter(slotId: number): Promise<void>;

/** Removes a waiter (timeout/cancel), idempotent. */
export function unregisterWaiter(slotId: number): void;

/** Wakes the waiter for slotId if registered. No-op otherwise. */
export function wakeWaiter(slotId: number): void;
```

No timer, no state besides the map. `wakeWaiter` for a slot that is not
(or no longer) registered is deliberately a no-op — the slot was then
either already seen as active or cancelled via timeout (the cleanup cron
removes orphaned `active` slots anyway).

### 2. `ai-queue/api.ts`: Promotion Reports the Winner

Everywhere a waiter is promoted `waiting → active`, the
`UPDATE … RETURNING id` yields the winner, and the caller wakes it:

- **`releaseSlot`**: `wakeWaiter(promotedId)` after the promotion.
- **`cleanupStaleSlots`**: likewise per affected model.

These are the only two places where a waiting slot becomes active (in
`acquireSlot` only the freshly inserted slot activates itself — its
caller gets the result back synchronously).

### 3. `ai-queue/slot-helper.ts`: Waiting Without Per-Second Polling

```ts
if (slot.status === "waiting") {
  const wakeup = registerWaiter(slotId);        // (a) register first
  try {
    // (b) race protection: promotion between acquire response and (a)?
    const recheck = await aiqueue.pollSlot({ slotId });
    if (recheck.status !== "active") {
      if (recheck.status === "cancelled") throw new AiSlotTimeoutError(...);
      // (c) wait: wakeup OR fallback poll OR timeout
      await waitForActive(slotId, wakeup, timeoutMs);
    }
  } finally {
    unregisterWaiter(slotId);
  }
}
```

`waitForActive` implements the wait loop:

- **Primary:** `await wakeup` — the normal case, latency ≈ 0 instead of up
  to 1 s today.
- **Fallback poll:** every `AI_QUEUE_FALLBACK_POLL_MS` (default
  **30,000 ms**) a `pollSlot` as a safety net against lost wakeups (bug,
  future multi-process topology). If the poll reports `active`, it is
  equivalent to the wakeup; `cancelled` → abort.
- **Timeout:** as today (`AI_QUEUE_SLOT_TIMEOUT_MS`, default 5 min) —
  on expiry `cancelSlot` + `AiSlotTimeoutError`.
- **Verification after wakeup:** after a wakeup, a single `pollSlot` for
  confirmation (`active`?). Costs one query at the rare wakeup moment
  instead of every second and makes the registry purely advisory — the DB
  remains the sole source of truth. If the status is unexpectedly still
  `waiting` (should not happen), keep waiting until fallback poll/timeout.

Important race considerations:

| Race | Handling |
| --- | --- |
| Promotion happens before the waiter is registered (between the `acquireSlot` response and `registerWaiter`) | One-time `pollSlot` recheck right after registration (step b) |
| Wakeup arrives after the waiter has given up via timeout | `wakeWaiter` is a no-op for unregistered slots; the slot deleted via `cancelSlot` or cleaned up by the cleanup cron does not block anything permanently |
| Timeout and wakeup at the same time (slot races to `active` at the moment of the timeout) | On timeout, `waitForActiveSlot` calls `cancelSlot` — it only deletes a row that is still `waiting` and prevents the `finally` `releaseSlot` from wrongly promoting a second active slot. If the slot is already `active`, `cancelSlot` is a no-op and the `finally` `releaseSlot` in `withAiSlot` releases it and promotes the next one. |

This interplay (`cancelSlot` for the waiting case, `finally` `releaseSlot`
for the active race) was already correct in the poll variant and is
retained as is — `cancelSlot` before `throw` is load-bearing here, because
a `releaseSlot` on a still-`waiting` row would otherwise promote a second
active slot.

### 4. Configuration

| Variable | before | after |
| --- | --- | --- |
| `AI_QUEUE_POLL_INTERVAL_MS` | 1000 ms active polling | **removed** — no longer read |
| `AI_QUEUE_FALLBACK_POLL_MS` | — | new, default 30,000 ms (safety net, read from the env per wait step) |
| `AI_QUEUE_SLOT_TIMEOUT_MS` | 300,000 ms | unchanged |
| `AI_QUEUE_STALE_TTL_MINUTES` | 5 min | unchanged (cleanup cron stays as a safeguard against crashed holders) |

### 5. Unchanged

- Table `ai_model_slot`, priority/FIFO ordering, `FOR UPDATE SKIP
  LOCKED` promotion — no migration needed.
- API contracts of `acquireSlot`/`pollSlot`/`releaseSlot`/`cancelSlot`
  (`pollSlot` is kept for the fallback, status UI and tests).
- All callers (`photo/scan-worker.ts`, `documents/scan-worker.ts`,
  `finance/tag-worker.ts`) — the signature of `withAiSlot` does not
  change.
- Cleanup cron (`ai-queue/cleanup-cron.ts`).

## Tests (`ai-queue/api.test.ts` + new `ai-queue/slot-helper.test.ts`)

1. **Wakeup happy path:** waiter B on model X; `releaseSlot(A)` →
   B's `withAiSlot` continues without a fallback poll (measurable via a
   short total duration ≪ fallback interval).
2. **Priorities:** two waiters (p1, p2) — the release wakes the
   p1 waiter, the p2 waiter stays registered and keeps waiting.
3. **Race acquire→register:** simulate promotion before `registerWaiter`
   → the recheck catches it, no hang.
4. **Timeout:** no release → `AiSlotTimeoutError` after `timeoutMs`,
   slot row is removed, registry empty (`unregisterWaiter` took effect).
5. **Timeout hits an activated slot:** slot becomes active immediately
   before the timeout → release instead of a zombie; the next waiter
   moves up.
6. **Cleanup cron wakes:** stale `active` + one waiter →
   `cleanupStaleSlots` promotes and wakes.
7. **Fallback poll:** suppress the wakeup (deliberately empty the
   registry) → the waiter still gets its turn via the fallback poll.
8. Existing `api.test.ts` cases stay green (contracts unchanged).

## Implementation Stages

1. `ai-queue/waiters.ts` + unit tests of the registry.
2. `api.ts`: promotion with `RETURNING id` + `wakeWaiter` in
   `releaseSlot` and `cleanupStaleSlots`.
3. `slot-helper.ts`: rebuild the wait loop (register → recheck →
   race(wakeup, fallback, timeout)), timeout path with
   release-instead-of-cancel for already activated slots.
4. Integration tests (list above), `npm run test` green.
5. Documentation polish (set this document to "implemented",
   add env variables to DEPLOYMENT.md if listed there).

Effort: small — three files plus tests, no migration, no outward API
change.

## Phase 2 (Optional): Multi-Process Capability

Only if the Encore services are ever split across several
processes/containers: `releaseSlot`/cleanup additionally fire
`pg_notify('ai_slot_activated', slotId)`; a dedicated
listener-connection module per process distributes incoming
notifications to the local registry. Registry API and `withAiSlot`
stay unchanged — only the transport layer of the wakeup changes.
