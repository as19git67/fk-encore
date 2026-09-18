/**
 * The feed for the iOS Spotlight index (#768, further idea 2).
 *
 * The iOS app puts photos that carry text — recognised inside the image
 * (`photo_ocr`, #1029) or written as a description — into Core Spotlight, so
 * a search on the phone's home screen for "Hauptbahnhof" finds the sign. Two
 * calls keep that index in step with the library without walking all of it:
 *
 * - `listChangedLogic` — the items that appeared or changed since a cursor,
 *   oldest change first, a page at a time. The client stores the cursor of
 *   the last item it saw and asks again from there.
 * - `listIdsLogic` — every id the index should hold right now. Deletions
 *   cannot travel through the delta (the OCR row cascades with the photo, so
 *   there is nothing left to report), and the client removes what is in its
 *   index but not in this list.
 *
 * Both answer only photos the user may see: their own and those in albums
 * they own or were invited to — the same rule as `GET /photos/details`.
 * Person names come from the user's own face assignments, since a person is
 * per user.
 */

import { sql } from "drizzle-orm";
import db from "../db/database";
import { UNNAMED_PERSON } from "./link-visibility.service";

/** Characters of recognised text an item carries. Spotlight matches on
 * words, and the first lines of a photographed page are what a query hits;
 * a whole page per item would only fatten the index. */
export const SPOTLIGHT_TEXT_CAP = 2000;
export const SPOTLIGHT_DEFAULT_LIMIT = 200;
export const SPOTLIGHT_MAX_LIMIT = 500;

export interface SpotlightIndexItem {
  id: number;
  /** Aufnahmedatum, ISO, when known. */
  taken_at?: string;
  /** Recognised text, capped to `SPOTLIGHT_TEXT_CAP`. Empty when the photo
   * is here for its description only. */
  text: string;
  description?: string;
  person_names: string[];
  /** The cursor value of this item — pass the last one back as `cursor`. */
  cursor: string;
}

export interface SpotlightIndexResponse {
  items: SpotlightIndexItem[];
  /** Present when more items follow; equals the last item's cursor. */
  next_cursor?: string;
}

export interface SpotlightIdsResponse {
  ids: number[];
}

/**
 * A cursor is "<changed_at ISO>|<photo id>", the position of the last item
 * seen in the (changed_at, id) order the delta walks. Opaque to the client;
 * malformed ones read as "from the beginning" rather than failing, since a
 * client that lost its cursor should re-sync, not get stuck.
 */
export function parseCursor(cursor: string | undefined): { changedAt: string; id: number } | null {
  if (!cursor) return null;
  const sep = cursor.lastIndexOf("|");
  if (sep <= 0) return null;
  const changedAt = cursor.slice(0, sep);
  const id = Number(cursor.slice(sep + 1));
  if (!Number.isInteger(id) || id <= 0) return null;
  if (Number.isNaN(Date.parse(changedAt))) return null;
  return { changedAt, id };
}

export function makeCursor(changedAt: string, id: number): string {
  return `${changedAt}|${id}`;
}

export function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit <= 0) return SPOTLIGHT_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), SPOTLIGHT_MAX_LIMIT);
}

/** Photos the user may see — own, or in an album they own or share. */
function visibleToUserSql(userId: number) {
  return sql`(
    p.user_id = ${userId}
    OR EXISTS (
      SELECT 1 FROM album_photos ap
      JOIN albums a ON a.id = ap.album_id
      LEFT JOIN album_shares s ON s.album_id = a.id AND s.user_id = ${userId}
      WHERE ap.photo_id = p.id AND (a.user_id = ${userId} OR s.user_id IS NOT NULL)
    )
  )`;
}

/** A photo belongs in the index when it has something Spotlight can match. */
const hasTextSql = sql`(COALESCE(po.full_text, '') <> '' OR COALESCE(p.description, '') <> '')`;

/** When the item last changed in a way the index cares about. `photos.updated_at`
 * moves on a description edit (and on curation, which is noise the client
 * tolerates); `photo_ocr.updated_at` on a (re)scan. */
const changedAtSql = sql`GREATEST(p.updated_at::timestamptz, po.updated_at)`;

/** The cursor spelling of `changedAtSql`: microsecond precision, UTC. A
 * JavaScript `Date` keeps only milliseconds, and a cursor rounded to those
 * compares *before* the row it came from, which hands that row out again on
 * every page. */
const changedAtTextSql = sql`to_char(${changedAtSql} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function listChangedLogic(
  userId: number,
  cursor: string | undefined,
  limit: number | undefined,
): Promise<SpotlightIndexResponse> {
  const pageSize = clampLimit(limit);
  const after = parseCursor(cursor);
  const afterSql = after
    ? sql`AND (${changedAtSql}, p.id) > (${after.changedAt}::timestamptz, ${after.id})`
    : sql``;

  const result = await db.execute(sql`
    SELECT
      p.id,
      p.taken_at,
      LEFT(COALESCE(po.full_text, ''), ${SPOTLIGHT_TEXT_CAP}) AS text,
      p.description,
      ${changedAtSql} AS changed_at,
      ${changedAtTextSql} AS changed_at_text,
      COALESCE((
        SELECT array_agg(DISTINCT pe.name ORDER BY pe.name)
        FROM faces f
        JOIN user_face_assignments ufa ON ufa.face_id = f.id AND ufa.user_id = ${userId}
          AND ufa.ignored = false AND ufa.person_id IS NOT NULL
        JOIN persons pe ON pe.id = ufa.person_id AND pe.name <> ${UNNAMED_PERSON}
        WHERE f.photo_id = p.id
      ), '{}'::text[]) AS person_names
    FROM photos p
    LEFT JOIN photo_ocr po ON po.photo_id = p.id
    WHERE ${visibleToUserSql(userId)}
      AND ${hasTextSql}
      ${afterSql}
    ORDER BY changed_at ASC, p.id ASC
    LIMIT ${pageSize + 1}
  `);
  const rows = result.rows as Array<{
    id: number; taken_at: string | Date | null; text: string; description: string | null;
    changed_at: string | Date; changed_at_text: string; person_names: string[] | null;
  }>;

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const items = page.map((r) => ({
    id: r.id,
    taken_at: r.taken_at ? toIso(r.taken_at) : undefined,
    text: r.text ?? "",
    description: r.description ?? undefined,
    person_names: r.person_names ?? [],
    cursor: makeCursor(r.changed_at_text, r.id),
  }));
  return {
    items,
    next_cursor: hasMore && items.length > 0 ? items[items.length - 1].cursor : undefined,
  };
}

export async function listIdsLogic(userId: number): Promise<SpotlightIdsResponse> {
  const result = await db.execute(sql`
    SELECT p.id
    FROM photos p
    LEFT JOIN photo_ocr po ON po.photo_id = p.id
    WHERE ${visibleToUserSql(userId)} AND ${hasTextSql}
    ORDER BY p.id
  `);
  return { ids: (result.rows as Array<{ id: number }>).map((r) => r.id) };
}

/** pg hands timestamps back as Date or as text depending on the column type. */
function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
