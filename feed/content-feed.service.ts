/**
 * Content-feed maintenance — Etappe 2 of the Instagram-style chronological
 * feed (see .claude/plans/instagram-style-feed.md).
 *
 * Keeps the materialized `photo_feed_entries` table in sync. The table holds
 * one row per (viewer, photo) with a monotonic `last_activity_at` sort key.
 * It is fanned out on write so the ordering stays viewer-accurate (variant B):
 * an activity in album X only bumps the photo for participants of X.
 *
 * Visibility rule: a photo is in user A's feed iff it lives in at least one
 * album A participates in (album owner OR a row in album_shares). Guests
 * (public-link access) are deliberately excluded.
 *
 * All functions are best-effort: a feed-bookkeeping failure must never break
 * the underlying photo/album operation, mirroring `emitFeedItem`. Bumps are
 * monotonic (GREATEST) — likes/favorites never bump, by design.
 */

import db from "../db/database";
import { sql, and, eq, inArray } from "drizzle-orm";
import { photoFeedEntries } from "../db/schema";

const TAG = "[content-feed]";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Users participating in ≥1 album that contains the photo — the
 * authoritative viewer set for the content feed. Album owners plus every
 * user the containing albums were shared with.
 */
export async function feedViewersForPhoto(photoId: number): Promise<number[]> {
  const res = await db.execute<{ user_id: number }>(sql`
    SELECT DISTINCT u.user_id FROM (
      SELECT a.user_id
      FROM albums a
      JOIN album_photos ap ON ap.album_id = a.id
      WHERE ap.photo_id = ${photoId}
      UNION
      SELECT s.user_id
      FROM album_shares s
      JOIN album_photos ap ON ap.album_id = s.album_id
      WHERE ap.photo_id = ${photoId}
    ) u
  `);
  return res.rows.map((r) => r.user_id);
}

/** Participants (owner + shared users) of a single album. */
async function albumParticipants(albumId: number): Promise<number[]> {
  const res = await db.execute<{ user_id: number }>(sql`
    SELECT user_id FROM albums WHERE id = ${albumId}
    UNION
    SELECT user_id FROM album_shares WHERE album_id = ${albumId}
  `);
  return res.rows.map((r) => r.user_id);
}

/**
 * Monotonic upsert: ensure each (user, photo) entry exists and its
 * last_activity_at is at least `ts`. Never lowers an existing value.
 */
async function bumpUsers(userIds: number[], photoId: number, ts: string): Promise<void> {
  const unique = Array.from(new Set(userIds));
  if (unique.length === 0) return;
  const values = sql.join(
    unique.map((uid) => sql`(${uid}, ${photoId}, ${ts}::timestamptz)`),
    sql`, `,
  );
  await db.execute(sql`
    INSERT INTO photo_feed_entries (user_id, photo_id, last_activity_at)
    VALUES ${values}
    ON CONFLICT (user_id, photo_id)
    DO UPDATE SET last_activity_at =
      GREATEST(photo_feed_entries.last_activity_at, EXCLUDED.last_activity_at)
  `);
}

/** A photo was added to an album → bump that album's participants. */
export async function onPhotoAddedToAlbum(
  photoId: number,
  albumId: number,
  ts: string = nowIso(),
): Promise<void> {
  try {
    const users = await albumParticipants(albumId);
    await bumpUsers(users, photoId, ts);
  } catch (err) {
    console.warn(`${TAG} onPhotoAddedToAlbum failed photo=${photoId} album=${albumId}: ${(err as Error).message}`);
  }
}

/** Several photos added to one album in a batch → bump participants once. */
export async function onPhotosAddedToAlbum(
  photoIds: number[],
  albumId: number,
  ts: string = nowIso(),
): Promise<void> {
  if (photoIds.length === 0) return;
  try {
    const users = await albumParticipants(albumId);
    if (users.length === 0) return;
    for (const photoId of photoIds) {
      await bumpUsers(users, photoId, ts);
    }
  } catch (err) {
    console.warn(`${TAG} onPhotosAddedToAlbum failed album=${albumId}: ${(err as Error).message}`);
  }
}

/** A comment was created/edited in an album → bump that album's participants. */
export async function onComment(
  photoId: number,
  albumId: number,
  ts: string = nowIso(),
): Promise<void> {
  try {
    const users = await albumParticipants(albumId);
    await bumpUsers(users, photoId, ts);
  } catch (err) {
    console.warn(`${TAG} onComment failed photo=${photoId} album=${albumId}: ${(err as Error).message}`);
  }
}

/**
 * Photo metadata (description, date, …) was edited → bump everyone who can
 * see the photo. Metadata is global to the photo, so every viewer "sees" it.
 */
export async function onPhotoMetadataEdited(
  photoId: number,
  ts: string = nowIso(),
): Promise<void> {
  try {
    const users = await feedViewersForPhoto(photoId);
    await bumpUsers(users, photoId, ts);
  } catch (err) {
    console.warn(`${TAG} onPhotoMetadataEdited failed photo=${photoId}: ${(err as Error).message}`);
  }
}

/**
 * An album was shared with a new user → that user gains every photo in the
 * album. Seed entries with each photo's existing activity (added_at, latest
 * comment in this album, metadata timestamp).
 */
export async function onAlbumShared(albumId: number, userId: number): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO photo_feed_entries (user_id, photo_id, last_activity_at)
      SELECT ${userId}, ap.photo_id,
        GREATEST(
          ap.added_at,
          (SELECT MAX(GREATEST(pc.created_at, COALESCE(pc.edited_at, pc.created_at)))
             FROM photo_comments pc
            WHERE pc.photo_id = ap.photo_id AND pc.album_id = ${albumId}),
          COALESCE(p.updated_at, p.created_at, NOW())
        )
      FROM album_photos ap
      JOIN photos p ON p.id = ap.photo_id
      WHERE ap.album_id = ${albumId}
      ON CONFLICT (user_id, photo_id)
      DO UPDATE SET last_activity_at =
        GREATEST(photo_feed_entries.last_activity_at, EXCLUDED.last_activity_at)
    `);
  } catch (err) {
    console.warn(`${TAG} onAlbumShared failed album=${albumId} user=${userId}: ${(err as Error).message}`);
  }
}

/**
 * A user lost a share (unshare / leave) → drop their entries for any of the
 * given photos they can no longer see via another album. Delete-only.
 */
export async function reconcileUserPhotos(userId: number, photoIds: number[]): Promise<void> {
  if (photoIds.length === 0) return;
  try {
    await db.delete(photoFeedEntries).where(and(
      eq(photoFeedEntries.user_id, userId),
      inArray(photoFeedEntries.photo_id, photoIds),
      sql`NOT EXISTS (
        SELECT 1 FROM album_photos ap
        JOIN albums a ON a.id = ap.album_id
        WHERE ap.photo_id = ${photoFeedEntries.photo_id}
          AND (a.user_id = ${userId}
               OR EXISTS (SELECT 1 FROM album_shares s
                           WHERE s.album_id = a.id AND s.user_id = ${userId}))
      )`,
    ));
  } catch (err) {
    console.warn(`${TAG} reconcileUserPhotos failed user=${userId}: ${(err as Error).message}`);
  }
}

/**
 * Photos' album membership changed (removed from album / album deleted) →
 * drop entries for any viewer who can no longer see them. Delete-only.
 */
export async function reconcilePhotoViewers(photoIds: number[]): Promise<void> {
  if (photoIds.length === 0) return;
  try {
    await db.delete(photoFeedEntries).where(and(
      inArray(photoFeedEntries.photo_id, photoIds),
      sql`NOT EXISTS (
        SELECT 1 FROM album_photos ap
        JOIN albums a ON a.id = ap.album_id
        WHERE ap.photo_id = ${photoFeedEntries.photo_id}
          AND (a.user_id = ${photoFeedEntries.user_id}
               OR EXISTS (SELECT 1 FROM album_shares s
                           WHERE s.album_id = a.id AND s.user_id = ${photoFeedEntries.user_id}))
      )`,
    ));
  } catch (err) {
    console.warn(`${TAG} reconcilePhotoViewers failed: ${(err as Error).message}`);
  }
}
