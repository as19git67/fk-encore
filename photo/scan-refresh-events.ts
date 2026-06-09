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
 * payload carries optional `albumIds` so album views can skip the refresh when
 * the scanned photo doesn't belong to the album being viewed.
 */
import { realtime } from "~encore/clients";

const DEBOUNCE_MS = 800;

/**
 * Per-user accumulator. `null` means "all albums potentially affected"
 * (e.g. after regrouping); a Set lists the specific album IDs whose photos
 * were scanned.
 */
const pendingUsers = new Map<number, Set<number> | null>();
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
  const entries = Array.from(pendingUsers.entries());
  pendingUsers.clear();
  if (entries.length === 0) return;
  for (const [userId, albumIds] of entries) {
    try {
      await realtime.publishEvent({
        userIds: [String(userId)],
        channel: "photos",
        type: "scan.updated",
        resourceId: "scan",
        payload: albumIds ? { albumIds: Array.from(albumIds) } : {},
      });
    } catch (err) {
      console.warn(
        `[scan-refresh-events] publish failed for user ${userId}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Signal that derived data (similar-photo groups, quality scores) changed for
 * `userId` after async scans, so their open views can refresh. Safe to call
 * from any completion hook — calls are coalesced and fire-and-forget.
 *
 * @param albumIds — album IDs whose photos were affected. Omit (or pass
 *   undefined) when the change is user-wide (e.g. regrouping) so every open
 *   album view refreshes.
 */
export function notifyUserPhotosScanned(userId: number, albumIds?: number[]): void {
  const existing = pendingUsers.get(userId);
  if (existing === null) {
    // already marked as "all albums" — nothing to widen
  } else if (!albumIds) {
    pendingUsers.set(userId, null);
  } else if (existing) {
    for (const id of albumIds) existing.add(id);
  } else {
    pendingUsers.set(userId, new Set(albumIds));
  }
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    flush().catch(() => {});
  }, DEBOUNCE_MS);
}
