/**
 * Bounded concurrency for scan workers' DB access.
 *
 * The photo service and the scan workers share a single pg Pool. By default
 * node-postgres caps the pool at 10 connections. If all 10 slots are held
 * by in-flight scan jobs (each of which waits on an external RPC while
 * holding a cursor for a `SELECT FOR UPDATE SKIP LOCKED` dequeue, or
 * writes results in batches), HTTP requests — including the Encore health
 * check and the photo-list endpoints — queue behind them and the UI feels
 * completely unresponsive.
 *
 * This module exposes a semaphore that workers must acquire before running
 * a job. The semaphore is sized at `poolMax - RESERVED_FOR_HTTP` so there
 * is always head-room for request handlers to grab a connection.
 *
 * Configuration:
 *   POSTGRES_POOL_MAX        – must match the pool config (default: 10)
 *   WORKER_DB_RESERVED_SLOTS – slots reserved for HTTP requests (default: 3)
 *
 * A tiny FIFO queue makes acquisition fair so workers don't starve each
 * other when contention spikes.
 */

const POOL_MAX = parseInt(process.env.POSTGRES_POOL_MAX ?? "10", 10);
const RESERVED = parseInt(process.env.WORKER_DB_RESERVED_SLOTS ?? "3", 10);

/** Max concurrent worker jobs that may hold a DB connection. */
const SLOT_CAPACITY = Math.max(1, POOL_MAX - Math.max(0, RESERVED));

let inUse = 0;
const waiters: Array<() => void> = [];

export async function acquireDbSlot(): Promise<void> {
  if (inUse < SLOT_CAPACITY) {
    inUse++;
    return;
  }
  // Wait for a slot to be handed off by releaseDbSlot. The releaser keeps
  // inUse unchanged when transferring to a waiter, so we don't increment here.
  await new Promise<void>((resolve) => waiters.push(resolve));
}

export function releaseDbSlot(): void {
  if (inUse <= 0) return;
  const next = waiters.shift();
  if (next) {
    // Hand the slot directly to the next waiter — inUse stays at the same
    // level because one holder just left and another is about to enter.
    next();
    return;
  }
  inUse--;
}

export function dbSlotStats(): { capacity: number; inUse: number; waiting: number } {
  return { capacity: SLOT_CAPACITY, inUse, waiting: waiters.length };
}
