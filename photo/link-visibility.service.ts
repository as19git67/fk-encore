/**
 * What an anonymous public-link visitor gets to see, photo by photo.
 *
 * The default is privacy-first: a photo carrying a face that an album
 * participant has assigned to a named person stays out of every public-link
 * view unless it is explicitly released. Pictures of people the household
 * knows are exactly the ones nobody wants to hand to a link that may be
 * forwarded, and requiring an opt-in for those is the only way that holds for
 * photos imported later, too.
 *
 * Per photo, `photos.link_visibility` says:
 *   'auto'    (default) — shown unless a known face is on it
 *   'visible'           — shown, known face or not (the explicit release)
 *   'hidden'            — never shown, face or not
 *
 * "Known face" is evaluated over all album participants (owner + collaborators)
 * rather than one user, because there is no current user on a link request and
 * a face only one collaborator has named is still a named face.
 *
 * None of this touches signed-in users: they keep seeing every photo their
 * account has access to.
 */

import { and, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbFirst, dbExec } from "../db/adapter";
import {
  albumPhotos,
  albumPublicLinks,
  albumShares,
  albums,
  faces,
  persons,
  photos,
  userFaceAssignments,
} from "../db/schema";
import type {
  PhotoLinkVisibility,
  SetKnownFaceLinkVisibilityResponse,
  UpdatePhotoLinkVisibilityResponse,
} from "../db/types";

/** Auto-created placeholder name for a person the user has not named yet. */
export const UNNAMED_PERSON = "Unbenannt";

export const LINK_VISIBILITY_VALUES: PhotoLinkVisibility[] = ["auto", "visible", "hidden"];

export class LinkVisibilityAccessError extends Error {
  constructor(message = "Photo not found or unauthorized") {
    super(message);
    this.name = "LinkVisibilityAccessError";
  }
}

/**
 * SQL predicate: the photo aliased `photoAlias` carries a face one of
 * `userIds` has assigned to a named person (and has not rejected).
 */
export function knownFaceExistsSql(photoAlias: SQL | string, userIds: number[]): SQL {
  const photoId = typeof photoAlias === "string" ? sql.raw(`${photoAlias}.id`) : photoAlias;
  if (userIds.length === 0) return sql`false`;
  return sql`EXISTS (
    SELECT 1
    FROM faces f
    JOIN user_face_assignments ufa
      ON ufa.face_id = f.id
     AND ufa.user_id = ANY(ARRAY[${sql.join(userIds.map(id => sql`${id}`), sql`, `)}]::int[])
     AND ufa.ignored = false
     AND ufa.person_id IS NOT NULL
    JOIN persons pe ON pe.id = ufa.person_id AND pe.name <> ${UNNAMED_PERSON}
    WHERE f.photo_id = ${photoId}
  )`;
}

/**
 * SQL predicate: the photo aliased `photoAlias` reaches a link visitor.
 * Mirrors the doc comment at the top of this file.
 */
export function linkVisiblePhotoSql(photoAlias: SQL | string, participantIds: number[]): SQL {
  const col = (name: string) =>
    typeof photoAlias === "string" ? sql.raw(`${photoAlias}.${name}`) : sql`${photoAlias}.${sql.raw(name)}`;
  return sql`(
    ${col("link_visibility")} = 'visible'
    OR (
      ${col("link_visibility")} = 'auto'
      AND NOT ${knownFaceExistsSql(photoAlias, participantIds)}
    )
  )`;
}

/** Owner plus everyone the album is shared with. */
export async function albumParticipantIds(albumId: number): Promise<number[]> {
  const rows = await dbAll<{ user_id: number }>(
    db
      .select({ user_id: albums.user_id })
      .from(albums)
      .where(eq(albums.id, albumId)),
  );
  const shareRows = await dbAll<{ user_id: number }>(
    db.select({ user_id: albumShares.user_id }).from(albumShares).where(eq(albumShares.album_id, albumId)),
  );
  return [...new Set([...rows.map(r => r.user_id), ...shareRows.map(r => r.user_id)])];
}

/** True when the album currently has a live public link. */
export async function albumHasActivePublicLink(albumId: number): Promise<boolean> {
  const row = await dbFirst<{ id: number }>(
    db
      .select({ id: albumPublicLinks.id })
      .from(albumPublicLinks)
      .where(and(
        eq(albumPublicLinks.album_id, albumId),
        sql`${albumPublicLinks.disabled_at} IS NULL`,
        sql`(${albumPublicLinks.expires_at} IS NULL OR ${albumPublicLinks.expires_at} > NOW())`,
      )),
  );
  return !!row;
}

/**
 * Photo IDs out of `photoIds` the user may change the link setting on.
 *
 * The setting is not per-user — it changes what every link visitor sees — so
 * read-only collaborators must not touch it. Allowed are the photo's owner and
 * anyone with write access to an album the photo sits in.
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

function assertVisibility(visibility: PhotoLinkVisibility): void {
  if (!LINK_VISIBILITY_VALUES.includes(visibility)) {
    throw APIError.invalidArgument(`Ungültige Link-Sichtbarkeit: ${visibility}`);
  }
}

/** Set the public-link visibility of one or more photos. */
export async function setPhotoLinkVisibilityLogic(
  userId: number,
  photoIds: number[],
  visibility: PhotoLinkVisibility,
): Promise<UpdatePhotoLinkVisibilityResponse> {
  assertVisibility(visibility);
  const unique = [...new Set(photoIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (unique.length === 0) return { success: true, updated: 0 };

  const allowed = await writablePhotoIds(userId, unique);
  if (allowed.length === 0) throw new LinkVisibilityAccessError();

  const changed = await dbAll<{ id: number }>(
    db
      .update(photos)
      .set({ link_visibility: visibility })
      .where(and(inArray(photos.id, allowed), sql`${photos.link_visibility} <> ${visibility}`))
      .returning({ id: photos.id }),
  );

  return { success: true, updated: changed.length };
}

/**
 * Bulk pass over every photo showing a face the caller assigned to a named
 * person: release them all to link visitors, or pin them shut.
 *
 * 'auto' restores the default (hidden while the known face is on them), which
 * is also how a release is undone.
 */
export async function setKnownFaceLinkVisibilityLogic(
  userId: number,
  opts: { visibility: PhotoLinkVisibility; albumId?: number; personIds?: number[] },
): Promise<SetKnownFaceLinkVisibilityResponse> {
  assertVisibility(opts.visibility);

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

  const personFilter =
    opts.personIds && opts.personIds.length > 0
      ? inArray(persons.id, opts.personIds)
      : sql`${persons.name} <> ${UNNAMED_PERSON}`;

  const candidates = await dbAll<{ id: number; link_visibility: string }>(
    db
      .selectDistinct({ id: photos.id, link_visibility: photos.link_visibility })
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

  const toChange = candidates.filter((c) => c.link_visibility !== opts.visibility).map((c) => c.id);
  const unchanged = candidates.length - toChange.length;
  if (toChange.length === 0) return { success: true, updated: 0, unchanged };

  // An album-scoped pass may cover photos owned by a collaborator; the album
  // write check above is what authorises those, so no per-photo filter here.
  await dbExec(
    db.update(photos).set({ link_visibility: opts.visibility }).where(inArray(photos.id, toChange)),
  );

  return { success: true, updated: toChange.length, unchanged };
}
