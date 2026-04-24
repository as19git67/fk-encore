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
  },
);

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
