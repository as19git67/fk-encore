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
  | "photo_commented";

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
  actorUserId: number;
  kind: FeedItemKind;
  albumId?: number | null;
  photoId?: number | null;
  payload?: Record<string, unknown>;
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
      dbFirst<{ name: string | null }>(
        db.select({ name: users.name }).from(users).where(eq(users.id, input.actorUserId)),
      ),
      input.albumId != null
        ? dbFirst<{ name: string | null }>(
            db.select({ name: albums.name }).from(albums).where(eq(albums.id, input.albumId)),
          )
        : Promise.resolve<{ name: string | null } | undefined>(undefined),
    ]);
    const actorName = actorRow?.name ?? null;
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
