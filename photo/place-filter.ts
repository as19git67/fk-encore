/**
 * Widens a `locationText` filter from the term to the place it names
 * (`place-resolve.ts`): its other spellings and the photos taken inside it.
 */

import { and, eq, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { photos } from "../db/schema";
import type { PhotoFilterParams } from "./photo.filters";
import { placeContains, resolvePlace, type ResolvedPlace } from "./place-resolve";

/** Photos matched by coordinates per call; a larger set is cut, newest kept. */
export const PLACE_PHOTO_CAP = 20_000;

/** The user's photos whose coordinates lie in the place. Exported for tests. */
export async function photosInPlace(userId: number, place: ResolvedPlace): Promise<number[]> {
  if (!place.bbox) return [];
  const [s, n, w, e] = place.bbox;
  // A box across the antimeridian has its west edge east of its east edge.
  const lonCond = w <= e
    ? sql`${photos.longitude} BETWEEN ${w} AND ${e}`
    : sql`(${photos.longitude} >= ${w} OR ${photos.longitude} <= ${e})`;
  const rows = await dbAll<{ id: number; latitude: number; longitude: number }>(
    db.select({ id: photos.id, latitude: photos.latitude, longitude: photos.longitude })
      .from(photos)
      .where(and(eq(photos.user_id, userId), sql`${photos.latitude} BETWEEN ${s} AND ${n}`, lonCond))
      .orderBy(sql`${photos.id} DESC`)
      .limit(PLACE_PHOTO_CAP * 2),
  );
  const ids: number[] = [];
  for (const r of rows) {
    if (ids.length >= PLACE_PHOTO_CAP) break;
    if (placeContains(place, Number(r.latitude), Number(r.longitude))) ids.push(r.id);
  }
  return ids;
}

/**
 * The filter with `locationNames` and `locationPhotoIds` filled in for its
 * `locationText`. Unchanged when there is none or the place is unknown.
 */
export async function resolveLocationFilter(userId: number, filter: PhotoFilterParams): Promise<PhotoFilterParams> {
  if (!filter.locationText) return filter;
  const place = await resolvePlace(filter.locationText);
  if (!place) return filter;
  return { ...filter, locationNames: place.names, locationPhotoIds: await photosInPlace(userId, place) };
}
