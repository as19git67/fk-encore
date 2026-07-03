/**
 * Per-document in-process serialization.
 *
 * Several code paths mutate a document's on-disk file and its
 * `disk_path` column concurrently:
 *   - the classify worker relocates a file after classification,
 *   - a user edit / visibility / tax change relocates it,
 *   - `replace-file` and `unlock` overwrite the bytes in place,
 *   - the receipt-OCR job replaces a receipt image,
 *   - the boot layout-migrator and the `/documents/layout/backfill`
 *     endpoint iterate and relocate.
 *
 * Without coordination two of these can interleave so that one moves the
 * file while the other computes a target from a *different* metadata
 * snapshot. The loser finds the source already gone and — before this was
 * guarded — still wrote its target into `disk_path`, leaving the row
 * pointing at a path where no file was ever written (the ENOENT seen when
 * a backup/reprocess later opens it).
 *
 * This module hands out a promise-chained mutex keyed by document id, so
 * every file+`disk_path` mutation for a given document runs to completion
 * before the next one starts. It is process-local, which is sufficient
 * for the single-container `encore build docker` deployment (the same
 * reason `lib/local-cron` can keep its scheduler in memory). It is NOT
 * re-entrant: never call `withDocumentLock` for the same id from inside a
 * callback already holding it, or the inner call will deadlock waiting on
 * the outer.
 */

console.log("[boot] documents/document-lock.ts: all imports resolved");

/**
 * Tail of the currently-pending chain per document id. Each new caller
 * chains onto the previous tail and installs itself as the new tail. The
 * entry is deleted once the chain drains, so the map only holds ids with
 * work in flight.
 */
const chains = new Map<number, Promise<unknown>>();

/**
 * Run `fn` with exclusive access to `documentId`, serialized against every
 * other `withDocumentLock` call for the same id. The caller receives `fn`'s
 * resolved value (or its rejection); a rejection from a *previous* holder
 * never prevents the next one from running.
 */
export function withDocumentLock<T>(
  documentId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(documentId) ?? Promise.resolve();
  // Run `fn` after the previous holder settles, regardless of its outcome
  // (both handlers are `fn`), so one failure doesn't wedge the queue.
  const run = prev.then(fn, fn);
  // Store a non-rejecting tail so the next waiter can safely chain on it.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(documentId, tail);
  // Drop the map entry once this link drains, unless a newer caller has
  // already replaced the tail (then that caller owns the cleanup).
  void tail.finally(() => {
    if (chains.get(documentId) === tail) chains.delete(documentId);
  });
  return run;
}

/** Test helper: true when no document currently holds the lock. */
export function _documentLocksIdle(): boolean {
  return chains.size === 0;
}
