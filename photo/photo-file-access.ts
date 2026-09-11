/**
 * Who may fetch a raw photo file from `/photos/file/*`.
 *
 * That endpoint cannot simply take `auth: true` like the render endpoints
 * did: it is the one image URL a public share link has to work with, and
 * a link recipient has no account. So it stays `auth: false` and decides
 * per request, along two separate lines:
 *
 *   1. A signed-in caller — the app, the iOS client — who holds the photos
 *      module and `photos.view`. Credentials arrive as a bearer header, or
 *      as `?token=` for `<img src>`, which cannot carry one.
 *
 *   2. A share-link visitor, who presents `?share=<token>`. That grants
 *      exactly the photos the link already exposes through
 *      `/albums/public/:token` and nothing else — not the rest of the
 *      library, and not photos a participant has hidden.
 *
 * Anything else is refused. Before this, the endpoint served any file to
 * anyone who could name it, and filenames are `YYYY/YYYY-MM/<timestamp>…`
 * — a shape narrow enough to walk.
 */

import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";
import db from "../db/database";
import { requirePermission } from "../user/auth-handler";
import {
  albumPublicLinks,
  albumPhotos,
  albumShares,
  albums,
  faces,
  persons,
  photoCuration,
  photos,
  userFaceAssignments,
} from "../db/schema";

/** What to answer with when a request may not have the file. */
export interface PhotoFileDenial {
  status: number;
  body: string;
}

/**
 * True when the share link is live and actually covers this file.
 *
 * The exclusions mirror `getPublicAlbumLogic` exactly: a photo any album
 * participant has hidden, one set to `link_visibility = 'hidden'`, and — by
 * default — one carrying a face a participant assigned to a named person are
 * all absent from the public listing, so none of them may be reachable by
 * filename either; otherwise hiding a photo after sharing the link would not
 * take effect for anyone who noted the URL.
 */
async function shareLinkCoversFile(token: string, filename: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1
    FROM ${albumPublicLinks} l
    JOIN ${albums} a ON a.id = l.album_id
    JOIN ${photos} p ON p.filename = ${filename}
    WHERE l.token = ${token}
      AND l.disabled_at IS NULL
      AND (l.expires_at IS NULL OR l.expires_at > NOW())
      -- Photos the link may not show — the per-photo opt-out, and by default
      -- anything with a known face on it — are absent from the public
      -- listing, so they must not be reachable by filename either.
      AND (
        p.link_visibility = 'visible'
        OR (
          p.link_visibility = 'auto'
          AND NOT EXISTS (
            SELECT 1
            FROM ${faces} f
            JOIN ${userFaceAssignments} ufa
              ON ufa.face_id = f.id
             AND ufa.ignored = false
             AND ufa.person_id IS NOT NULL
             AND (
               ufa.user_id = a.user_id
               OR ufa.user_id IN (
                 SELECT s.user_id FROM ${albumShares} s WHERE s.album_id = l.album_id
               )
             )
            JOIN ${persons} pe ON pe.id = ufa.person_id AND pe.name <> 'Unbenannt'
            WHERE f.photo_id = p.id
          )
        )
      )
      AND (
        EXISTS (
          SELECT 1 FROM ${albumPhotos} ap
          WHERE ap.album_id = l.album_id AND ap.photo_id = p.id
        )
        -- The cover is served to link previews (Open Graph) even in the
        -- rare case it is not itself a member of the album.
        OR a.cover_photo_id = p.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${photoCuration} pc
        WHERE pc.photo_id = p.id
          AND pc.status = 'hidden'
          AND (
            pc.user_id = a.user_id
            OR pc.user_id IN (
              SELECT s.user_id FROM ${albumShares} s WHERE s.album_id = l.album_id
            )
          )
      )
    LIMIT 1
  `);
  return result.rows.length > 0;
}

/** True when this caller may read the photo library at large. */
function isPhotoViewer(authData: { permissions: string[] }): boolean {
  try {
    requirePermission(authData, "module.photos");
    requirePermission(authData, "photos.view");
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether the current request may read `filename`.
 *
 * Returns null when it may, or the status/body to answer with when it may
 * not. Raw handlers get no automatic error mapping, so the caller writes
 * the response itself.
 *
 * The two grants are checked independently and the caller gets the union of
 * them, because having an account is not the same as having photo rights:
 * somebody who only uses the finance module still has to be able to open a
 * share link that was sent to them. Their session simply says nothing about
 * this album, so it must not shadow the token that does.
 *
 * A share token that exists but does not cover the file is answered exactly
 * like a caller with no credentials at all, so the endpoint cannot be used
 * to probe which filenames are real.
 */
export async function denyPhotoFileRequest(
  filename: string,
  shareToken: string | null,
): Promise<PhotoFileDenial | null> {
  const authData = getAuthData();
  if (authData && isPhotoViewer(authData)) return null;

  if (shareToken && (await shareLinkCoversFile(shareToken, filename))) return null;

  if (!authData && !shareToken) return { status: 401, body: "Unauthorized" };
  return { status: 403, body: "Forbidden" };
}
