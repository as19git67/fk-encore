/**
 * Realtime fan-out for "a user's photo scans produced new derived data".
 *
 * The heavy photo pipeline (embedding → similar-photo grouping, quality
 * scoring) runs asynchronously after upload. Without a signal the album view
 * keeps showing stale data — review badges that aren't tappable yet and "?%"
 * quality hints — until the user remounts the view. This helper pushes a
 * single per-user `photos/scan.updated` event so open views can refresh live.
 *
 * Calls are coalesced: a bulk upload finishing hundreds of scan jobs collapses
 * into at most one event per DEBOUNCE_MS across all pending users. The event
 * carries no payload — it is a "your photos changed, refetch" signal.
 */
import { realtime } from "~encore/clients";

const DEBOUNCE_MS = 800;

const pendingUserIds = new Set<number>();
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
  const userIds = Array.from(pendingUserIds);
  pendingUserIds.clear();
  if (userIds.length === 0) return;
  try {
    await realtime.publishEvent({
      userIds: userIds.map((id) => String(id)),
      channel: "photos",
      type: "scan.updated",
      resourceId: "scan",
      payload: {},
    });
  } catch (err) {
    console.warn(
      `[scan-refresh-events] publish failed: ${(err as Error).message}`,
    );
  }
}

/**
 * Signal that derived data (similar-photo groups, quality scores) changed for
 * `userId` after async scans, so their open views can refresh. Safe to call
 * from any completion hook — calls are coalesced and fire-and-forget.
 */
export function notifyUserPhotosScanned(userId: number): void {
  pendingUserIds.add(userId);
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    flush().catch(() => {});
  }, DEBOUNCE_MS);
}
