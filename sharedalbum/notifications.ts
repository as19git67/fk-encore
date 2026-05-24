// Notification producer: fan-out-on-write of album events to guests.
//
// Called by the photo and reactions services whenever an event lands
// that share-link recipients should learn about (new photos, new
// comments). One row per (guest, album, event) is inserted into
// guest_notifications; the digest cron (see digest-cron.ts) drains
// that queue into mails, and Web Push fires best-effort inline.

import { api } from "encore.dev/api";
import { sql } from "drizzle-orm";
import db from "../db/database";
import { buildGuestNotification, sendToGuest } from "./push";

/**
 * Fan-out for an album-scoped event — e.g. one or more photos were
 * added to `albumId`. Writes a guest_notifications row for every
 * verified, opted-in guest who has accessed any still-active public
 * link for this album, and fires Web Push best-effort alongside.
 */
interface FanoutAlbumInput {
  albumId: number;
  kind: "photo_added" | "comment_added";
  payload?: Record<string, unknown>;
  /** Skip this guest (used when a guest is the actor). */
  excludeGuestId?: number;
}

export const fanoutAlbum = api(
  { expose: false },
  async (req: FanoutAlbumInput): Promise<void> => {
    // photo_added events arrive in bursts (e.g. iOS uploads call POST
    // /albums/photos once per photo, so a 20-photo upload would otherwise
    // fire 20 separate Web Push notifications). Coalesce them per album
    // through the debounce buffer; comment_added stays immediate because
    // comments are one-off events.
    if (req.kind === "photo_added") {
      const ids: number[] = [];
      const raw = req.payload?.photoIds;
      if (Array.isArray(raw)) {
        for (const id of raw as unknown[]) {
          if (typeof id === "number" && Number.isFinite(id)) ids.push(id);
        }
      }
      enqueuePhotoAddedFanout(req.albumId, ids, req.excludeGuestId ?? null);
      return;
    }
    await runFanoutAlbum(req);
  },
);

async function runFanoutAlbum(req: FanoutAlbumInput): Promise<void> {
  const payloadJson = JSON.stringify(req.payload ?? {});
  const exclude = req.excludeGuestId ?? null;
  const result = await db.execute<EnrichedInsertRow>(sql`
    WITH ins AS (
      INSERT INTO guest_notifications (guest_id, album_id, kind, payload)
      SELECT DISTINCT g.id, ${req.albumId}, ${req.kind}, ${payloadJson}::jsonb
      FROM guests g
      INNER JOIN guest_link_access gla ON gla.guest_id = g.id
      INNER JOIN album_public_links apl ON apl.id = gla.public_link_id
      WHERE apl.album_id = ${req.albumId}
        AND (apl.expires_at IS NULL OR apl.expires_at > NOW())
        AND g.notify_opt_in = TRUE
        AND g.verified_at IS NOT NULL
        AND (${exclude}::int IS NULL OR g.id <> ${exclude}::int)
      RETURNING guest_id, album_id, kind, payload
    )
    SELECT
      ins.guest_id, ins.album_id, ins.kind, ins.payload,
      a.name AS album_name,
      (
        SELECT apl.token
        FROM album_public_links apl
        INNER JOIN guest_link_access gla ON gla.public_link_id = apl.id
        WHERE apl.album_id = ins.album_id
          AND gla.guest_id = ins.guest_id
          AND (apl.expires_at IS NULL OR apl.expires_at > NOW())
        ORDER BY gla.first_seen_at ASC
        LIMIT 1
      ) AS link_token
    FROM ins
    INNER JOIN albums a ON a.id = ins.album_id
  `);
  await fanoutPushBestEffort((result as any).rows as EnrichedInsertRow[]);
}

/**
 * Fan-out for a photo-scoped event — typically a new comment. One
 * row per (guest, album) pair: if the same photo is in two public-
 * linked albums a guest has access to, they get one notification per
 * album (different subject lines / mail groupings).
 */
interface FanoutPhotoInput {
  photoId: number;
  kind: "comment_added";
  payload?: Record<string, unknown>;
  excludeGuestId?: number;
}

export const fanoutPhoto = api(
  { expose: false },
  async (req: FanoutPhotoInput): Promise<void> => {
    const payloadJson = JSON.stringify(req.payload ?? {});
    const exclude = req.excludeGuestId ?? null;
    const result = await db.execute<EnrichedInsertRow>(sql`
      WITH ins AS (
        INSERT INTO guest_notifications (guest_id, album_id, kind, payload)
        SELECT DISTINCT g.id, apl.album_id, ${req.kind}, ${payloadJson}::jsonb
        FROM guests g
        INNER JOIN guest_link_access gla ON gla.guest_id = g.id
        INNER JOIN album_public_links apl ON apl.id = gla.public_link_id
        INNER JOIN album_photos ap ON ap.album_id = apl.album_id
        WHERE ap.photo_id = ${req.photoId}
          AND (apl.expires_at IS NULL OR apl.expires_at > NOW())
          AND g.notify_opt_in = TRUE
          AND g.verified_at IS NOT NULL
          AND (${exclude}::int IS NULL OR g.id <> ${exclude}::int)
        RETURNING guest_id, album_id, kind, payload
      )
      SELECT
        ins.guest_id, ins.album_id, ins.kind, ins.payload,
        a.name AS album_name,
        (
          SELECT apl.token
          FROM album_public_links apl
          INNER JOIN guest_link_access gla ON gla.public_link_id = apl.id
          WHERE apl.album_id = ins.album_id
            AND gla.guest_id = ins.guest_id
            AND (apl.expires_at IS NULL OR apl.expires_at > NOW())
          ORDER BY gla.first_seen_at ASC
          LIMIT 1
        ) AS link_token
      FROM ins
      INNER JOIN albums a ON a.id = ins.album_id
    `);
    await fanoutPushBestEffort((result as any).rows as EnrichedInsertRow[]);
  },
);

// ---------- Push fan-out ----------

interface EnrichedInsertRow extends Record<string, unknown> {
  guest_id: number;
  album_id: number;
  kind: "photo_added" | "comment_added";
  payload: Record<string, unknown> | null;
  album_name: string;
  link_token: string | null;
}

/**
 * Fire Web Push to every guest whose notification row was just
 * inserted. Best-effort: errors on individual endpoints are swallowed
 * inside sendToGuest; lookup/build errors are logged here but never
 * thrown so the caller's primary INSERT isn't affected.
 */
async function fanoutPushBestEffort(rows: EnrichedInsertRow[]): Promise<void> {
  if (rows.length === 0) return;
  await Promise.all(
    rows.map(async (row) => {
      if (!row.link_token) return; // no active link → can't deep-link
      try {
        const payload = buildGuestNotification({
          kind: row.kind,
          albumName: row.album_name,
          albumLinkToken: row.link_token,
          payload: row.payload ?? {},
        });
        await sendToGuest(row.guest_id, payload);
      } catch (err) {
        console.warn(
          `[sharedalbum.notifications] push fanout failed guest=${row.guest_id}: ${(err as Error).message}`,
        );
      }
    }),
  );
}

// ---------- photo_added debounce buffer ----------
//
// Bursty photo_added fanouts are coalesced per album so a 20-photo
// upload yields one DB row + one Web Push instead of twenty. The timer
// resets on every new photo within the quiet window; a hard cap keeps
// notifications from being delayed indefinitely during a continuous
// upload (e.g. an iCloud sync streaming hundreds of photos).
const PHOTO_FANOUT_QUIET_MS = 5 * 60_000;
const PHOTO_FANOUT_MAX_WAIT_MS = 30 * 60_000;

interface PendingPhotoFanout {
  albumId: number;
  photoIds: Set<number>;
  excludeGuestId: number | null;
  firstEnqueuedAt: number;
  timer: NodeJS.Timeout;
}

const pendingPhotoFanouts = new Map<string, PendingPhotoFanout>();

function bucketKey(albumId: number, excludeGuestId: number | null): string {
  return `${albumId}:${excludeGuestId ?? ""}`;
}

function scheduleTimer(key: string, delayMs: number): NodeJS.Timeout {
  const t = setTimeout(() => {
    void flushPhotoFanout(key);
  }, Math.max(0, delayMs));
  // Don't keep the process alive solely for pending notifications —
  // also keeps vitest from hanging on dangling timers.
  if (typeof t.unref === "function") t.unref();
  return t;
}

function enqueuePhotoAddedFanout(
  albumId: number,
  photoIds: number[],
  excludeGuestId: number | null,
): void {
  if (photoIds.length === 0) return;
  const key = bucketKey(albumId, excludeGuestId);
  const existing = pendingPhotoFanouts.get(key);
  if (existing) {
    for (const id of photoIds) existing.photoIds.add(id);
    const elapsed = Date.now() - existing.firstEnqueuedAt;
    const remainingCap = PHOTO_FANOUT_MAX_WAIT_MS - elapsed;
    if (remainingCap <= 0) return; // flush already imminent / firing
    clearTimeout(existing.timer);
    existing.timer = scheduleTimer(key, Math.min(PHOTO_FANOUT_QUIET_MS, remainingCap));
    return;
  }
  pendingPhotoFanouts.set(key, {
    albumId,
    photoIds: new Set(photoIds),
    excludeGuestId,
    firstEnqueuedAt: Date.now(),
    timer: scheduleTimer(key, PHOTO_FANOUT_QUIET_MS),
  });
}

async function flushPhotoFanout(key: string): Promise<void> {
  const bucket = pendingPhotoFanouts.get(key);
  if (!bucket) return;
  pendingPhotoFanouts.delete(key);
  clearTimeout(bucket.timer);
  try {
    await runFanoutAlbum({
      albumId: bucket.albumId,
      kind: "photo_added",
      payload: { photoIds: Array.from(bucket.photoIds) },
      excludeGuestId: bucket.excludeGuestId ?? undefined,
    });
  } catch (err) {
    console.warn(
      `[sharedalbum.notifications] debounced photo fanout failed album=${bucket.albumId}: ${(err as Error).message}`,
    );
  }
}

/**
 * Immediately flush every pending photo_added bucket. Intended for
 * tests so they don't have to wait the full debounce window; production
 * code does not call this.
 */
export async function flushPendingPhotoFanouts(): Promise<void> {
  const keys = Array.from(pendingPhotoFanouts.keys());
  for (const key of keys) {
    await flushPhotoFanout(key);
  }
}
