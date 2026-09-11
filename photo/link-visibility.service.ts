/**
 * Per-photo opt-out of public link sharing.
 *
 * A photo flagged `link_hidden` stays fully visible to signed-in users and to
 * album collaborators, but is excluded from every anonymous public-link view
 * of every album it belongs to — the listing (`getPublicAlbumLogic`), the
 * album cover, and the raw file endpoint (`photo-file-access.ts`). The flag
 * lives on the photo itself rather than per album, because "don't show this
 * one to strangers" is a property of the picture, not of one sharing of it.
 *
 * Besides the manual per-photo toggle there is a bulk pass that sets the flag
 * on every photo carrying a face the caller has assigned to a named person —
 * the quick way to keep family faces off a link that goes out to a wider
 * circle.
 */

import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbFirst, dbExec } from "../db/adapter";
import {
  albumPhotos,
  albumShares,
  albums,
  faces,
  persons,
  photos,
  userFaceAssignments,
} from "../db/schema";
import type {
  AutoHideKnownFacesResponse,
  UpdatePhotoLinkVisibilityResponse,
} from "../db/types";

/** Auto-created placeholder name for a person the user has not named yet. */
const UNNAMED_PERSON = "Unbenannt";

export class LinkVisibilityAccessError extends Error {
  constructor(message = "Photo not found or unauthorized") {
    super(message);
    this.name = "LinkVisibilityAccessError";
  }
}

/**
 * Photo IDs out of `photoIds` the user may change the link flag on.
 *
 * The flag is not per-user — flipping it changes what every link visitor
 * sees — so read-only collaborators must not set it. Allowed are the photo's
 * owner and anyone with write access to an album the photo sits in.
 */
async function writablePhotoIds(userId: number, photoIds: number[]): Promise<number[]> {
  if (photoIds.length === 0) return [];
  const rows = await dbAll<{ id: number }>(
    db
      .selectDistinct({ id: photos.id })
      .from(photos)
      .leftJoin(albumPhotos, eq(albumPhotos.photo_id, photos.id))
      .leftJoin(albums, eq(albums.id, albumPhotos.album_id))
      .where(
        and(
          inArray(photos.id, photoIds),
          or(
            eq(photos.user_id, userId),
            eq(albums.user_id, userId),
            sql`EXISTS (
              SELECT 1 FROM ${albumShares} s
              WHERE s.album_id = ${albums.id}
                AND s.user_id = ${userId}
                AND s.access_level IN ('write', 'write_share')
            )`,
          ),
        ),
      ),
  );
  return rows.map((r) => r.id);
}

/** Set (or clear) the public-link opt-out on one or more photos. */
export async function setPhotoLinkVisibilityLogic(
  userId: number,
  photoIds: number[],
  linkHidden: boolean,
): Promise<UpdatePhotoLinkVisibilityResponse> {
  const unique = [...new Set(photoIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (unique.length === 0) return { success: true, updated: 0 };

  const allowed = await writablePhotoIds(userId, unique);
  if (allowed.length === 0) throw new LinkVisibilityAccessError();

  const changed = await dbAll<{ id: number }>(
    db
      .update(photos)
      .set({ link_hidden: linkHidden })
      .where(and(inArray(photos.id, allowed), eq(photos.link_hidden, !linkHidden)))
      .returning({ id: photos.id }),
  );

  return { success: true, updated: changed.length };
}

/**
 * Flag every photo showing a face the caller assigned to a named person.
 *
 * Faces are per-user data: the pass uses the caller's own assignments, skips
 * the auto-created "Unbenannt" placeholder persons (those are detections, not
 * recognitions) and skips faces the caller marked as ignored.
 */
export async function autoHideKnownFacesLogic(
  userId: number,
  opts: { albumId?: number; personIds?: number[] } = {},
): Promise<AutoHideKnownFacesResponse> {
  const personFilter =
    opts.personIds && opts.personIds.length > 0
      ? inArray(persons.id, opts.personIds)
      : sql`${persons.name} != ${UNNAMED_PERSON}`;

  if (opts.albumId !== undefined) {
    const album = await dbFirst<typeof albums.$inferSelect>(
      db.select().from(albums).where(eq(albums.id, opts.albumId)),
    );
    if (!album) throw APIError.notFound("Album nicht gefunden.");
    if (album.user_id !== userId) {
      const share = await dbFirst<typeof albumShares.$inferSelect>(
        db
          .select()
          .from(albumShares)
          .where(and(eq(albumShares.album_id, opts.albumId), eq(albumShares.user_id, userId))),
      );
      if (!share || (share.access_level !== "write" && share.access_level !== "write_share")) {
        throw APIError.permissionDenied("Keine Schreibrechte für dieses Album.");
      }
    }
  }

  const candidates = await dbAll<{ id: number; link_hidden: boolean }>(
    db
      .selectDistinct({ id: photos.id, link_hidden: photos.link_hidden })
      .from(photos)
      .innerJoin(faces, eq(faces.photo_id, photos.id))
      .innerJoin(
        userFaceAssignments,
        and(
          eq(userFaceAssignments.face_id, faces.id),
          eq(userFaceAssignments.user_id, userId),
          eq(userFaceAssignments.ignored, false),
          isNotNull(userFaceAssignments.person_id),
        ),
      )
      .innerJoin(persons, eq(persons.id, userFaceAssignments.person_id))
      .where(
        and(
          eq(persons.user_id, userId),
          personFilter,
          opts.albumId !== undefined
            ? sql`EXISTS (
                SELECT 1 FROM ${albumPhotos} ap
                WHERE ap.photo_id = ${photos.id} AND ap.album_id = ${opts.albumId}
              )`
            : eq(photos.user_id, userId),
        ),
      ),
  );

  const toHide = candidates.filter((c) => !c.link_hidden).map((c) => c.id);
  const alreadyHidden = candidates.length - toHide.length;
  if (toHide.length === 0) return { success: true, updated: 0, alreadyHidden };

  // The album-scoped pass may cover photos owned by a collaborator; the album
  // write check above is what authorises those, so no per-photo filter here.
  await dbExec(db.update(photos).set({ link_hidden: true }).where(inArray(photos.id, toHide)));

  return { success: true, updated: toHide.length, alreadyHidden };
}
