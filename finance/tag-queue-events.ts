/**
 * Realtime fan-out for finance tag queue state changes.
 *
 * Every queue mutation calls `notifyFinanceTagQueueChanged()`. Calls
 * are debounced into at most one "scan-queue/state.changed" event per
 * DEBOUNCE_MS so a burst of enqueues or completions doesn't flood the
 * outbox. The event carries no payload — the UI refetches the REST
 * status endpoint. Mirrors photo/scan-queue-events.ts exactly.
 *
 * Uses the same `scan-queue` channel and `state.changed` event type so
 * the existing DataManagement frontend subscription picks it up without
 * any client-side changes.
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
      `[finance.tag-queue-events] admin lookup failed: ${(err as Error).message}`,
    );
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
      resourceId: "finance-tag-queue",
      payload: {},
    });
  } catch (err) {
    console.warn(
      `[finance.tag-queue-events] publish failed: ${(err as Error).message}`,
    );
  }
}

export function notifyFinanceTagQueueChanged(): void {
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    flush().catch(() => {});
  }, DEBOUNCE_MS);
}
