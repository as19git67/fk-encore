/**
 * Social-feed business logic.
 *
 * The feed materialises every activity that album participants should
 * see — photos added to shared albums, new shares, likes, comments —
 * as one `feed_items` row per recipient. Fan-out happens at write
 * time via `emitFeedItems` (called from photo.service and the future
 * reactions endpoints); listing is a simple paginated SELECT.
 *
 * Every emitted item is also forwarded to the realtime bus so open
 * feed views prepend new entries without polling.
 */

import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec, dbFirst } from "../db/adapter";
import { feedItems, users, albums, photos } from "../db/schema";
import { realtime, push } from "~encore/clients";

export type FeedItemKind =
  | "photo_added"
  | "album_shared"
  | "photo_favorited"
  | "photo_commented"
  | "album_left";

export interface FeedItem {
  id: number;
  kind: FeedItemKind;
  actor: {
    id: number | null;
    name: string | null;
  };
  album: {
    id: number;
    name: string;
  } | null;
  photo: {
    id: number;
    filename: string;
  } | null;
  payload: Record<string, unknown>;
  seen_at: string | null;
  created_at: string;
}

export interface ListFeedRequest {
  /** Paginate by returning items older than this id. */
  cursor?: number;
  limit?: number;
}

export interface ListFeedResponse {
  items: FeedItem[];
  /** Cursor for the next page; `null` means there is no more history. */
  nextCursor: number | null;
  unreadCount: number;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

interface FeedRow {
  id: number;
  kind: FeedItemKind;
  actor_user_id: number | null;
  actor_name: string | null;
  album_id: number | null;
  album_name: string | null;
  photo_id: number | null;
  photo_filename: string | null;
  payload: Record<string, unknown>;
  seen_at: string | null;
  created_at: string;
}

export async function listFeedForUser(
  userId: number,
  req: ListFeedRequest,
): Promise<ListFeedResponse> {
  const limit = clampLimit(req.limit);

  const cursorFilter =
    typeof req.cursor === "number" && Number.isFinite(req.cursor)
      ? lt(feedItems.id, req.cursor)
      : undefined;

  const rows = await dbAll<FeedRow>(
    db
      .select({
        id: feedItems.id,
        kind: feedItems.kind,
        actor_user_id: feedItems.actor_user_id,
        actor_name: users.name,
        album_id: feedItems.album_id,
        album_name: albums.name,
        photo_id: feedItems.photo_id,
        photo_filename: photos.filename,
        payload: feedItems.payload,
        seen_at: feedItems.seen_at,
        created_at: feedItems.created_at,
      })
      .from(feedItems)
      .leftJoin(users, eq(users.id, feedItems.actor_user_id))
      .leftJoin(albums, eq(albums.id, feedItems.album_id))
      .leftJoin(photos, eq(photos.id, feedItems.photo_id))
      .where(
        cursorFilter
          ? and(eq(feedItems.user_id, userId), cursorFilter)
          : eq(feedItems.user_id, userId),
      )
      .orderBy(desc(feedItems.created_at), desc(feedItems.id))
      .limit(limit + 1),
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const items: FeedItem[] = page.map((r) => ({
    id: r.id,
    kind: r.kind,
    actor: { id: r.actor_user_id, name: r.actor_name },
    album:
      r.album_id != null
        ? { id: r.album_id, name: r.album_name ?? "" }
        : null,
    photo:
      r.photo_id != null
        ? {
            id: r.photo_id,
            filename: r.photo_filename ?? "",
          }
        : null,
    payload: r.payload,
    seen_at: r.seen_at,
    created_at: r.created_at,
  }));

  const unreadCount = await countUnread(userId);

  return {
    items,
    nextCursor: hasMore ? page[page.length - 1].id : null,
    unreadCount,
  };
}

export async function countUnread(userId: number): Promise<number> {
  const row = await dbFirst<{ n: number }>(
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(feedItems)
      .where(
        and(eq(feedItems.user_id, userId), isNull(feedItems.seen_at)),
      ),
  );
  return row?.n ?? 0;
}

export interface MarkSeenRequest {
  /** Mark everything up to and including this feed-item id as seen. */
  upToId: number;
}

export async function markSeenForUser(
  userId: number,
  req: MarkSeenRequest,
): Promise<{ updated: number }> {
  if (!Number.isFinite(req.upToId) || req.upToId <= 0) {
    return { updated: 0 };
  }
  const { changes } = await dbExec(
    db
      .update(feedItems)
      .set({ seen_at: sql`NOW()` })
      .where(
        and(
          eq(feedItems.user_id, userId),
          isNull(feedItems.seen_at),
          // <= upToId; feed_items.id is monotonically increasing.
          sql`${feedItems.id} <= ${req.upToId}`,
        ),
      ),
  );
  return { updated: changes };
}

export interface EmitFeedInput {
  recipients: number[];
  // null when a non-user (e.g. a shared-album guest) is the actor;
  // payload then carries a guestName instead.
  actorUserId: number | null;
  kind: FeedItemKind;
  albumId?: number | null;
  photoId?: number | null;
  payload?: Record<string, unknown>;
}

/**
 * Public entry point. `photo_added` events get coalesced per album
 * through the debounce buffer below so a 20-photo upload yields one
 * feed entry (and one Web Push) per recipient instead of twenty.
 * Every other kind passes straight through to `emitFeedItems`.
 */
export async function scheduleEmitFeedItems(input: EmitFeedInput): Promise<void> {
  if (input.kind === "photo_added" && input.albumId != null) {
    const photoIds: number[] = [];
    if (typeof input.photoId === "number") photoIds.push(input.photoId);
    const rawIds = input.payload?.photoIds;
    if (Array.isArray(rawIds)) {
      for (const id of rawIds as unknown[]) {
        if (typeof id === "number" && Number.isFinite(id)) photoIds.push(id);
      }
    }
    if (photoIds.length === 0) return;
    enqueuePhotoAddedFeed(input.albumId, input.actorUserId, input.recipients, photoIds);
    return;
  }
  await emitFeedItems(input);
}

/**
 * Fan-out entry point used by photo.service and the future reactions
 * endpoints. Writes one `feed_items` row per recipient (deduplicating
 * the input list) and publishes a realtime `feed/item.added` event so
 * open feed views slot the new entry in without polling.
 *
 * Recipients that equal the actor are skipped — you don't get a feed
 * card for your own action.
 */
export async function emitFeedItems(input: EmitFeedInput): Promise<void> {
  const unique = Array.from(new Set(input.recipients)).filter(
    (uid) => uid !== input.actorUserId,
  );
  if (unique.length === 0) return;

  const rows = await dbAll<{ id: number; user_id: number; created_at: string }>(
    db
      .insert(feedItems)
      .values(
        unique.map((uid) => ({
          user_id: uid,
          actor_user_id: input.actorUserId,
          kind: input.kind,
          album_id: input.albumId ?? null,
          photo_id: input.photoId ?? null,
          payload: input.payload ?? {},
        })),
      )
      .returning({
        id: feedItems.id,
        user_id: feedItems.user_id,
        created_at: feedItems.created_at,
      }),
  );

  // Realtime: one event per recipient. Errors must not break the
  // caller's operation — the DB rows already exist, so the next feed
  // reload picks them up.
  try {
    await Promise.all(
      rows.map((row) =>
        realtime.publishEvent({
          userIds: [String(row.user_id)],
          channel: "feed",
          type: "item.added",
          resourceId: String(row.id),
          payload: {
            kind: input.kind,
            actorUserId: input.actorUserId,
            albumId: input.albumId ?? null,
            photoId: input.photoId ?? null,
            ...input.payload,
          },
        }),
      ),
    );
  } catch (err) {
    console.warn(
      `[feed] realtime publish failed for kind=${input.kind}: ${(err as Error).message}`,
    );
  }

  // Web push fan-out. Best-effort — users without push subscriptions
  // get nothing, and any delivery error is swallowed so a flaky push
  // service never breaks the primary operation.
  try {
    const [actorRow, albumRow] = await Promise.all([
      input.actorUserId != null
        ? dbFirst<{ name: string | null }>(
            db.select({ name: users.name }).from(users).where(eq(users.id, input.actorUserId)),
          )
        : Promise.resolve<{ name: string | null } | undefined>(undefined),
      input.albumId != null
        ? dbFirst<{ name: string | null }>(
            db.select({ name: albums.name }).from(albums).where(eq(albums.id, input.albumId)),
          )
        : Promise.resolve<{ name: string | null } | undefined>(undefined),
    ]);
    // For guest-authored events the payload carries a `guestName` that
    // the push layer can surface; fall back to that when no actorRow.
    const actorName =
      actorRow?.name ??
      (typeof input.payload?.guestName === "string" ? (input.payload.guestName as string) : null);
    const albumName = albumRow?.name ?? null;

    await Promise.all(
      rows.map((row) =>
        push
          .fanoutFeed({
            userId: row.user_id,
            kind: input.kind,
            actorName,
            albumName,
            albumId: input.albumId ?? null,
            photoId: input.photoId ?? null,
            payload: input.payload ?? {},
          })
          .catch((err: unknown) => {
            console.warn(
              `[feed] push fanout failed kind=${input.kind} user=${row.user_id}: ${(err as Error).message}`,
            );
          }),
      ),
    );
  } catch (err) {
    console.warn(
      `[feed] push metadata lookup failed kind=${input.kind}: ${(err as Error).message}`,
    );
  }
}

// ---------- photo_added debounce buffer ----------
//
// Mirrors the guest fanout debouncer in sharedalbum/notifications.ts:
// bursts of photo_added events for the same album coalesce into a
// single feed_items row per recipient (with photoIds in payload) and
// therefore a single Web Push reading "N Fotos hinzugefügt" instead of
// N "ein Foto" pushes.
const FEED_PHOTO_QUIET_MS = 60_000;
const FEED_PHOTO_MAX_WAIT_MS = 10 * 60_000;

interface PendingFeedFanout {
  albumId: number;
  actorUserId: number | null;
  recipients: Set<number>;
  photoIds: Set<number>;
  firstEnqueuedAt: number;
  timer: NodeJS.Timeout;
}

const pendingFeedFanouts = new Map<string, PendingFeedFanout>();

function feedBucketKey(actorUserId: number | null, albumId: number): string {
  return `${actorUserId ?? "g"}:${albumId}`;
}

function scheduleFeedTimer(key: string, delayMs: number): NodeJS.Timeout {
  const t = setTimeout(() => {
    void flushFeedFanout(key);
  }, Math.max(0, delayMs));
  if (typeof t.unref === "function") t.unref();
  return t;
}

function enqueuePhotoAddedFeed(
  albumId: number,
  actorUserId: number | null,
  recipients: number[],
  photoIds: number[],
): void {
  const key = feedBucketKey(actorUserId, albumId);
  const existing = pendingFeedFanouts.get(key);
  if (existing) {
    for (const id of photoIds) existing.photoIds.add(id);
    for (const r of recipients) existing.recipients.add(r);
    const elapsed = Date.now() - existing.firstEnqueuedAt;
    const remainingCap = FEED_PHOTO_MAX_WAIT_MS - elapsed;
    if (remainingCap <= 0) return;
    clearTimeout(existing.timer);
    existing.timer = scheduleFeedTimer(key, Math.min(FEED_PHOTO_QUIET_MS, remainingCap));
    return;
  }
  pendingFeedFanouts.set(key, {
    albumId,
    actorUserId,
    recipients: new Set(recipients),
    photoIds: new Set(photoIds),
    firstEnqueuedAt: Date.now(),
    timer: scheduleFeedTimer(key, FEED_PHOTO_QUIET_MS),
  });
}

async function flushFeedFanout(key: string): Promise<void> {
  const bucket = pendingFeedFanouts.get(key);
  if (!bucket) return;
  pendingFeedFanouts.delete(key);
  clearTimeout(bucket.timer);
  const photoIds = Array.from(bucket.photoIds);
  try {
    await emitFeedItems({
      recipients: Array.from(bucket.recipients),
      actorUserId: bucket.actorUserId,
      kind: "photo_added",
      albumId: bucket.albumId,
      // Surface the first photo on the feed_items row so existing
      // thumbnail rendering keeps working; the full list lives in
      // payload.photoIds for plural rendering and deep-linking.
      photoId: photoIds[0] ?? null,
      payload: { photoIds },
    });
  } catch (err) {
    console.warn(
      `[feed] debounced photo fanout failed album=${bucket.albumId}: ${(err as Error).message}`,
    );
  }
}

/**
 * Immediately flush every pending photo_added bucket. Intended for
 * tests so they don't have to wait the full debounce window; production
 * code does not call this.
 */
export async function flushPendingFeedFanouts(): Promise<void> {
  const keys = Array.from(pendingFeedFanouts.keys());
  for (const key of keys) {
    await flushFeedFanout(key);
  }
}
