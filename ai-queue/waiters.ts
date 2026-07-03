/**
 * In-process waiter registry for the AI-queue push-wakeup.
 *
 * All Encore-TS services run inside a single Node process (one fk-encore
 * container sharing one Postgres pool), so `ai-queue/api.ts` (which promotes
 * and wakes) and `ai-queue/slot-helper.ts` (which waits) see the same
 * module-singleton registry. A waiting slot registers here and gets resolved
 * the moment its slot is promoted to `active`, instead of polling the DB every
 * second.
 *
 * The registry is purely advisory — the DB (`ai_model_slot`) stays the single
 * source of truth. A wakeup only tells the waiter "check now"; the waiter still
 * confirms the real status with a single `pollSlot`. `wakeWaiter` for a slot
 * that is not (or no longer) registered is intentionally a no-op: the waiter
 * either already observed `active`, timed out, or was cleaned up.
 *
 * Should the topology ever be split across multiple processes, this registry
 * degrades gracefully — the fallback poll in the waiter still makes progress,
 * it just loses the instant-wakeup latency. Phase 2 (see
 * docs/ai-queue-push-wakeup.md) would add Postgres LISTEN/NOTIFY as a
 * cross-process transport without changing this API.
 */

/** slotId → resolve() of the waiter's pending wakeup promise. */
const waiters = new Map<number, () => void>();

/**
 * Register a waiter for `slotId` and return a promise that resolves when
 * `wakeWaiter(slotId)` is called. Registering the same slot twice replaces the
 * previous resolver (the old promise then never resolves on its own and must be
 * abandoned by its caller) — callers register exactly once per wait, so this is
 * not expected in practice.
 */
export function registerWaiter(slotId: number): Promise<void> {
  return new Promise<void>((resolve) => {
    waiters.set(slotId, resolve);
  });
}

/** Remove a waiter (on timeout/cancel/completion). Idempotent. */
export function unregisterWaiter(slotId: number): void {
  waiters.delete(slotId);
}

/**
 * Wake the waiter registered for `slotId`, if any. No-op when the slot is not
 * registered. The resolver is removed before being called so a second wakeup
 * cannot double-fire.
 */
export function wakeWaiter(slotId: number): void {
  const resolve = waiters.get(slotId);
  if (resolve) {
    waiters.delete(slotId);
    resolve();
  }
}

/** Test helper: number of currently registered waiters. */
export function waiterCount(): number {
  return waiters.size;
}
