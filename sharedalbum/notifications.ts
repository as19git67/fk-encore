// Notification producer: fan-out-on-write of album events to guests.
//
// Called by the photo and reactions services whenever an event lands
// that share-link recipients should learn about (new photos, new
// comments). One row per (guest, album, event) is inserted into
// guest_notifications; the digest cron (etappe 5) drains that queue
// into mails, and the Web Push pipeline (etappe 6) fires best-effort
// alongside.

import { api } from "encore.dev/api";
import { sql } from "drizzle-orm";
import db from "../db/database";

/**
 * Fan-out for an album-scoped event — e.g. one or more photos were
 * added to `albumId`. Writes a guest_notifications row for every
 * verified, opted-in guest who has accessed any still-active public
 * link for this album.
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
    await db.execute(sql`
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
    `);
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
    await db.execute(sql`
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
    `);
  },
);
