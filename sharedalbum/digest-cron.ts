// Digest cron for guest notifications.
//
// Drains guest_notifications into one summary mail per guest. The
// cron ticks every 15 minutes but a guest is only eligible when their
// newest pending event is at least 30 minutes old — this 30-minute
// quiet window collapses bursts (e.g. a 50-photo upload) into a
// single mail without making individual events wait 15 minutes on
// average.

import { everyMs, schedule } from "../lib/local-cron";
import { api } from "encore.dev/api";
import { sql } from "drizzle-orm";
import log from "encore.dev/log";
import db from "../db/database";
import { sendGuestDigestEmail, type GuestDigestGroup } from "../user/mail";

console.log("[boot] sharedalbum/digest-cron.ts: all imports resolved");

interface RawRow extends Record<string, unknown> {
  guest_id: number;
  email: string;
  display_name: string;
  unsubscribe_token: string;
  notify_opt_in: boolean;
  album_id: number;
  album_name: string;
  link_token: string | null;
  kind: string;
  payload: Record<string, unknown> | null;
  notif_id: number;
  created_at: string;
}

export const sendGuestDigests = api(
  { expose: false, method: "POST", path: "/internal/sharedalbum/digest" },
  async (): Promise<{ guests: number; mails: number }> => {
    // Atomically CLAIM every deliverable notification (set delivered_at)
    // in the same statement that reads it, then send. The previous
    // read-then-mark-after-send sequence left a window where the same
    // rows were emailed more than once — when the cron overlapped itself,
    // ran on multiple replicas, or the send succeeded but the follow-up
    // mark failed and the rows were retried on the next tick. Claiming
    // up front makes each notification mail at-most-once.
    const result = await db.execute<RawRow>(sql`
      WITH eligible AS (
        SELECT guest_id
        FROM guest_notifications
        WHERE delivered_at IS NULL
        GROUP BY guest_id
        HAVING MAX(created_at) <= NOW() - INTERVAL '30 minutes'
      ),
      claimed AS (
        UPDATE guest_notifications
        SET delivered_at = NOW()
        WHERE delivered_at IS NULL
          AND guest_id IN (SELECT guest_id FROM eligible)
        RETURNING id AS notif_id, guest_id, album_id, kind, payload, created_at
      )
      SELECT
        c.guest_id,
        g.email,
        g.display_name,
        g.unsubscribe_token,
        g.notify_opt_in,
        c.notif_id,
        c.album_id,
        c.kind,
        c.payload,
        c.created_at,
        a.name AS album_name,
        (
          SELECT apl.token
          FROM album_public_links apl
          INNER JOIN guest_link_access gla ON gla.public_link_id = apl.id
          WHERE apl.album_id = c.album_id
            AND gla.guest_id = c.guest_id
            AND (apl.expires_at IS NULL OR apl.expires_at > NOW())
          ORDER BY gla.first_seen_at ASC
          LIMIT 1
        ) AS link_token
      FROM claimed c
      INNER JOIN guests g ON g.id = c.guest_id
      INNER JOIN albums a ON a.id = c.album_id
      ORDER BY c.guest_id, c.album_id, c.created_at
    `);
    const rows = (result as any).rows as RawRow[];
    if (rows.length === 0) return { guests: 0, mails: 0 };

    const byGuest = new Map<number, RawRow[]>();
    for (const r of rows) {
      const list = byGuest.get(r.guest_id);
      if (list) list.push(r);
      else byGuest.set(r.guest_id, [r]);
    }

    let mailsSent = 0;
    for (const [guestId, guestRows] of byGuest) {
      // Rows are already claimed (delivered_at set) above, so a send
      // failure here drops that digest rather than risking a duplicate
      // on the next tick — consistent with best-effort Web Push.
      try {
        const first = guestRows[0];
        // Opted-out guests had their rows claimed too (so they don't
        // accumulate forever) but receive no mail.
        if (!first.notify_opt_in) continue;
        const groups = aggregate(guestRows);
        if (groups.length > 0) {
          await sendGuestDigestEmail({
            to: first.email,
            displayName: first.display_name,
            unsubscribeToken: first.unsubscribe_token,
            groups,
          });
          mailsSent += 1;
        }
      } catch (err) {
        log.error(err as any, "sharedalbum.digest.guest_failed");
        console.warn(
          `[sharedalbum] digest failed for guest=${guestId}: ${(err as Error).message}`,
        );
      }
    }

    return { guests: byGuest.size, mails: mailsSent };
  },
);

function aggregate(rows: RawRow[]): GuestDigestGroup[] {
  const byAlbum = new Map<number, RawRow[]>();
  for (const r of rows) {
    const list = byAlbum.get(r.album_id);
    if (list) list.push(r);
    else byAlbum.set(r.album_id, [r]);
  }

  const out: GuestDigestGroup[] = [];
  for (const albumRows of byAlbum.values()) {
    const first = albumRows[0];
    // If none of the guest's links for this album are still active
    // (e.g. all were rotated or expired) we skip the album silently —
    // linking them into the mail would produce a broken URL.
    if (!first.link_token) continue;

    let newPhotos = 0;
    const photoIds: number[] = [];
    const newComments: Array<{ authorName: string; excerpt: string; photoId?: number }> = [];
    for (const r of albumRows) {
      if (r.kind === "photo_added") {
        const ids = Array.isArray(r.payload?.photoIds) ? (r.payload!.photoIds as unknown[]) : [];
        newPhotos += ids.length;
        for (const id of ids) {
          if (typeof id === "number") photoIds.push(id);
        }
      } else if (r.kind === "comment_added") {
        const photoId = typeof r.payload?.photoId === "number" ? r.payload.photoId : undefined;
        newComments.push({
          authorName: pickString(r.payload?.authorName) ?? "Jemand",
          excerpt: pickString(r.payload?.excerpt) ?? "",
          photoId,
        });
      }
    }

    if (newPhotos === 0 && newComments.length === 0) continue;

    out.push({
      albumName: first.album_name,
      albumLinkToken: first.link_token,
      newPhotos,
      newComments,
    });
  }
  return out;
}

function pickString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

schedule({
  name: "guest-digest",
  description: "Shared-album guest notification digest",
  service: "sharedalbum",
  scheduleLabel: "every 15m",
  nextFire: everyMs(15 * 60_000),
  run: () => sendGuestDigests(),
});
