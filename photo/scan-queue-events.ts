/**
 * Realtime fan-out for scan-queue state changes.
 *
 * Every scan-queue mutation (enqueue, dequeue, done, failed, defer,
 * cancel, requeue) calls `notifyScanQueueChanged()`. The helper
 * debounces bursts into at most one "scan-queue/state.changed" event
 * every DEBOUNCE_MS, so a bulk rescan finishing hundreds of jobs
 * doesn't flood the outbox. The event itself carries no payload — it
 * is a signal telling the UI to refetch `/photos/scan-queue/status`.
 *
 * Audience: every user with `data.manage` (the same permission the
 * REST endpoint requires). The admin list is cached for ADMIN_CACHE_MS
 * so we don't hit the DB on every burst.
 */
import { realtime, user } from "~encore/clients";

const DEBOUNCE_MS = 500;
const ADMIN_CACHE_MS = 30_000;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let cachedAdminIds: string[] | null = null;
let cachedAdminAt = 0;

async function loadAdminIds(): Promise<string[]> {
  const now = Date.now();
  if (cachedAdminIds && now - cachedAdminAt < ADMIN_CACHE_MS) {
    return cachedAdminIds;
  }
  try {
    const { userIds } = await user.listUserIdsWithPermission({
      permission: "data.manage",
    });
    cachedAdminIds = userIds.map((id: number) => String(id));
    cachedAdminAt = now;
  } catch (err) {
    console.warn(
      `[scan-queue-events] admin lookup failed: ${(err as Error).message}`,
    );
    // Keep previous cache (possibly null) so we fall back gracefully.
  }
  return cachedAdminIds ?? [];
}

async function flush(): Promise<void> {
  const userIds = await loadAdminIds();
  if (userIds.length === 0) return;
  try {
    await realtime.publishEvent({
      userIds,
      channel: "scan-queue",
      type: "state.changed",
      resourceId: "queue",
      payload: {},
    });
  } catch (err) {
    console.warn(
      `[scan-queue-events] publish failed: ${(err as Error).message}`,
    );
  }
}

/**
 * Signal that the scan queue state changed. Safe to call from any
 * mutating queue helper — calls are coalesced and fire-and-forget.
 */
export function notifyScanQueueChanged(): void {
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    flush().catch(() => {});
  }, DEBOUNCE_MS);
}
