/**
 * Per-recipient debounce + online-suppression for feed Web Push.
 *
 * Why: a burst of social activity (e.g. someone favoriting several photos,
 * or a mix of favorites and comments) used to fire one Web Push per event,
 * spamming the recipient. This buffers the pushes per user over a quiet
 * window and delivers a single coalesced notification.
 *
 * Two rules:
 *  1. Online-suppression — if the recipient currently has a live realtime
 *     (WebSocket) session, skip the push entirely: they already receive the
 *     `feed/item.added` event live in the app.
 *  2. Debounce — otherwise hold the event in a per-user buffer with a quiet
 *     window (reset on each new event) and a hard cap, then flush one push.
 *
 * In-memory, process-local — consistent with the existing photo_added feed
 * debounce and the single-instance realtime session registry. A process
 * restart drops pending pushes; acceptable for best-effort notifications
 * (the durable `feed_items` rows remain and are shown on next app open).
 *
 * Only the social feed path (push.fanoutFeed) routes through here. Operational
 * pushes (finance statements, document review) stay immediate — they have no
 * live realtime equivalent, so suppressing them while "online" would drop
 * them entirely.
 */

import { realtime } from "~encore/clients";
import type { FeedItemKind } from "../feed/feed.service";
import { buildFeedNotification, sendToUser, type PushPayload } from "./push.service";

export interface FeedPushEvent {
  kind: FeedItemKind;
  actorName: string | null;
  albumName: string | null;
  albumId: number | null;
  photoId: number | null;
  payload: Record<string, unknown>;
}

interface Pending {
  events: FeedPushEvent[];
  firstEnqueuedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Dependencies, injectable so tests can run without timers/realtime/web-push. */
export interface FeedPushDeps {
  /** Whether the recipient currently has a live realtime session. */
  isOnline: (userId: number) => Promise<boolean>;
  /** Deliver the (possibly coalesced) notification. */
  send: (userId: number, payload: PushPayload) => Promise<unknown>;
  /** Quiet window: reset on each new event. */
  quietMs: number;
  /** Hard cap measured from the first buffered event. */
  maxWaitMs: number;
}

const defaultDeps: FeedPushDeps = {
  isOnline: async (userId) => {
    try {
      const res = await realtime.connectionStatus({ userId: String(userId) });
      return res.connected;
    } catch {
      // If presence can't be determined, treat as offline so the push still
      // goes out (better a possibly-redundant push than a silently dropped one).
      return false;
    }
  },
  send: (userId, payload) => sendToUser(userId, payload),
  quietMs: 10 * 60_000,
  maxWaitMs: 30 * 60_000,
};

let deps: FeedPushDeps = { ...defaultDeps };

/** Test seam: override some/all dependencies. */
export function __setFeedPushDeps(overrides: Partial<FeedPushDeps>): void {
  deps = { ...deps, ...overrides };
}

/** Test seam: reset deps and clear any pending buffers/timers. */
export function __resetFeedPush(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  deps = { ...defaultDeps };
}

const pending = new Map<number, Pending>();

/**
 * Enqueue a feed push for a recipient. Returns immediately. If the user is
 * online the event is dropped (they see it live); otherwise it is buffered
 * and flushed after the quiet window (bounded by the hard cap).
 */
export async function scheduleFeedPush(userId: number, ev: FeedPushEvent): Promise<void> {
  if (await deps.isOnline(userId)) return;

  const existing = pending.get(userId);
  if (existing) {
    existing.events.push(ev);
    const elapsed = Date.now() - existing.firstEnqueuedAt;
    const remainingCap = deps.maxWaitMs - elapsed;
    if (remainingCap <= 0) return; // capped timer already due; let it fire
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => void flushUser(userId), Math.min(deps.quietMs, remainingCap));
    return;
  }

  const timer = setTimeout(() => void flushUser(userId), Math.min(deps.quietMs, deps.maxWaitMs));
  pending.set(userId, { events: [ev], firstEnqueuedAt: Date.now(), timer });
}

/** Flush a user's buffered pushes now (also invoked by the debounce timer). */
export async function flushUser(userId: number): Promise<void> {
  const p = pending.get(userId);
  if (!p) return;
  pending.delete(userId);
  clearTimeout(p.timer);

  // Re-check at delivery: if the user came back online while we waited,
  // they will see the activity in-app — no push needed.
  if (await deps.isOnline(userId)) return;

  const payload =
    p.events.length === 1 ? buildFeedNotification(p.events[0]!) : buildFeedDigest(p.events);
  try {
    await deps.send(userId, payload);
  } catch (err) {
    console.warn(`[push] debounced feed push failed user=${userId}: ${(err as Error).message}`);
  }
}

function photoCountOf(ev: FeedPushEvent): number {
  const ids = ev.payload?.photoIds;
  return Array.isArray(ids) && ids.length > 0 ? ids.length : 1;
}

/** Singular/plural German phrase for a kind's aggregated count. */
function phraseFor(kind: FeedItemKind, n: number): string | null {
  switch (kind) {
    case "photo_added":
      return n === 1 ? "1 neues Foto" : `${n} neue Fotos`;
    case "photo_favorited":
      return n === 1 ? "1 neuer Favorit" : `${n} neue Favoriten`;
    case "photo_commented":
      return n === 1 ? "1 neuer Kommentar" : `${n} neue Kommentare`;
    case "album_shared":
      return n === 1 ? "1 geteiltes Album" : `${n} geteilte Alben`;
    case "album_left":
      return n === 1 ? "1 verlassene Freigabe" : `${n} verlassene Freigaben`;
    default:
      return null;
  }
}

// Order kinds appear in the digest body.
const KIND_ORDER: FeedItemKind[] = [
  "photo_added",
  "photo_favorited",
  "photo_commented",
  "album_shared",
  "album_left",
];

/**
 * Coalesce several buffered feed events into one notification summarizing the
 * counts by kind, e.g. "3 neue Favoriten, 1 neuer Kommentar".
 */
export function buildFeedDigest(events: FeedPushEvent[]): PushPayload {
  const counts = new Map<FeedItemKind, number>();
  for (const e of events) {
    const inc = e.kind === "photo_added" ? photoCountOf(e) : 1;
    counts.set(e.kind, (counts.get(e.kind) ?? 0) + inc);
  }

  const parts: string[] = [];
  for (const kind of KIND_ORDER) {
    const n = counts.get(kind) ?? 0;
    if (n > 0) {
      const phrase = phraseFor(kind, n);
      if (phrase) parts.push(phrase);
    }
  }

  // Deep-link: a single shared album → that album; otherwise the feed.
  const albumIds = new Set(
    events.map((e) => e.albumId).filter((x): x is number => typeof x === "number"),
  );
  const url = albumIds.size === 1 ? `/app/fotos/alben/${[...albumIds][0]}` : "/app/fotos/feed";

  const body = parts.length > 0 ? parts.join(", ") : `${events.length} neue Benachrichtigungen`;

  return {
    title: "F4mil",
    body,
    url,
    // Single tag so a refreshed digest replaces the previous one instead of stacking.
    tag: "f4mil-feed-digest",
    data: { kind: "digest", count: events.length },
  };
}
