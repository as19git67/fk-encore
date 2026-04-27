/**
 * In-process abort registry for active library scans.
 *
 * Lives in its own module so both libraries.service.ts (which registers an
 * AbortController when a scan starts) and library-scan-queue.ts (which fires
 * the abort from cancelPendingLibraryScans) can use it without forming an
 * import cycle.
 *
 * Single-instance only: a multi-replica backend would still need a DB-backed
 * cancellation channel — same caveat as the existing activeScans lock.
 */

const activeAborts = new Map<number, AbortController>();

export function registerScanAbort(libraryId: number): AbortController {
  const ctrl = new AbortController();
  activeAborts.set(libraryId, ctrl);
  return ctrl;
}

export function unregisterScanAbort(libraryId: number, ctrl: AbortController): void {
  if (activeAborts.get(libraryId) === ctrl) {
    activeAborts.delete(libraryId);
  }
}

export function abortAllLibraryScans(): number {
  let n = 0;
  for (const ctrl of activeAborts.values()) {
    if (!ctrl.signal.aborted) {
      ctrl.abort();
      n++;
    }
  }
  return n;
}
