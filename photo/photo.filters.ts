import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  photos,
  photoCuration,
  albumPhotos,
  albumShares,
  faces,
  userFaceAssignments,
  photoGroups,
  photoGroupMembers,
  albums,
} from "../db/schema";

export type HiddenMode = "exclude" | "include" | "only";
export type MembershipMode = "include" | "exclude";
export type MediaType = "photo" | "video" | "raw";

export interface PhotoFilterParams {
  hiddenMode?: HiddenMode;
  favorite?: boolean;
  albumHighlight?: boolean;
  groupHighlight?: boolean;
  inGroup?: boolean;
  othersFavorited?: boolean;
  othersHidden?: boolean;
  qualityMin?: number;
  qualityMax?: number;
  notInAnyAlbum?: boolean;
  albumIds?: number[];
  albumMode?: MembershipMode;
  personIds?: number[];
  personMode?: MembershipMode;
  mediaTypes?: MediaType[];
  hasGps?: boolean;
  hasFaces?: boolean;
  hasAssignedPerson?: boolean;
  dateFrom?: string;
  dateTo?: string;
  importedDaysAgo?: number;
  sizeMin?: number;
  sizeMax?: number;
  // AI auto-pick filter (Track I, see migration 0075):
  //   "exclude" (default) — hide non-picked members of high-confidence
  //                         AI-picked groups that the user has not yet
  //                         reviewed. The grid shows only the AI pick.
  //   "include"           — show every photo regardless of AI pick;
  //                         the marker is still rendered.
  //   "only"              — only photos the AI hid. Used by the "show
  //                         KI-ausgeblendete anzeigen" filter toggle.
  aiHiddenMode?: HiddenMode;
  /**
   * Album-detail grid scope. NOT a filter — `buildPhotoFilterConditions`
   * deliberately ignores it. When set, the gallery-grid logic scopes the
   * result to this album's photos (with an access check) instead of the
   * caller's own photos, so a shared album also renders in the grid for
   * non-owner viewers.
   */
  albumScopeId?: number;
}

export interface PhotoFilterQuery {
  showHidden?: boolean;
  hiddenMode?: string;
  favorite?: boolean;
  albumHighlight?: boolean;
  groupHighlight?: boolean;
  inGroup?: boolean;
  othersFavorited?: boolean;
  othersHidden?: boolean;
  qualityMin?: number;
  qualityMax?: number;
  notInAnyAlbum?: boolean;
  albumIds?: string;
  albumMode?: string;
  personIds?: string;
  personMode?: string;
  mediaTypes?: string;
  hasGps?: boolean;
  hasFaces?: boolean;
  hasAssignedPerson?: boolean;
  dateFrom?: string;
  dateTo?: string;
  importedDaysAgo?: number;
  sizeMin?: number;
  sizeMax?: number;
  showAiHidden?: boolean;
  aiHiddenMode?: string;
  albumScopeId?: number;
}

function parseIntArray(s: string): number[] {
  return s
    .split(",")
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function parseMediaTypes(s: string): MediaType[] {
  const valid: MediaType[] = ["photo", "video", "raw"];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x): x is MediaType => (valid as string[]).includes(x));
}

export function parsePhotoFilterQuery(q: PhotoFilterQuery): PhotoFilterParams {
  const f: PhotoFilterParams = {};
  if (q.hiddenMode === "exclude" || q.hiddenMode === "include" || q.hiddenMode === "only") {
    f.hiddenMode = q.hiddenMode;
  } else if (q.showHidden === true) {
    f.hiddenMode = "include";
  }
  if (q.favorite !== undefined) f.favorite = Boolean(q.favorite);
  if (q.albumHighlight !== undefined) f.albumHighlight = Boolean(q.albumHighlight);
  if (q.groupHighlight !== undefined) f.groupHighlight = Boolean(q.groupHighlight);
  if (q.inGroup !== undefined) f.inGroup = Boolean(q.inGroup);
  if (q.othersFavorited !== undefined) f.othersFavorited = Boolean(q.othersFavorited);
  if (q.othersHidden !== undefined) f.othersHidden = Boolean(q.othersHidden);
  if (q.qualityMin !== undefined) f.qualityMin = Number(q.qualityMin);
  if (q.qualityMax !== undefined) f.qualityMax = Number(q.qualityMax);
  if (q.notInAnyAlbum !== undefined) f.notInAnyAlbum = Boolean(q.notInAnyAlbum);
  if (q.albumIds) f.albumIds = parseIntArray(q.albumIds);
  if (q.albumMode === "include" || q.albumMode === "exclude") f.albumMode = q.albumMode;
  if (q.personIds) f.personIds = parseIntArray(q.personIds);
  if (q.personMode === "include" || q.personMode === "exclude") f.personMode = q.personMode;
  if (q.mediaTypes) f.mediaTypes = parseMediaTypes(q.mediaTypes);
  if (q.hasGps !== undefined) f.hasGps = Boolean(q.hasGps);
  if (q.hasFaces !== undefined) f.hasFaces = Boolean(q.hasFaces);
  if (q.hasAssignedPerson !== undefined) f.hasAssignedPerson = Boolean(q.hasAssignedPerson);
  if (q.dateFrom) f.dateFrom = q.dateFrom;
  if (q.dateTo) f.dateTo = q.dateTo;
  if (q.importedDaysAgo !== undefined) f.importedDaysAgo = Number(q.importedDaysAgo);
  if (q.sizeMin !== undefined) f.sizeMin = Number(q.sizeMin);
  if (q.sizeMax !== undefined) f.sizeMax = Number(q.sizeMax);
  if (q.aiHiddenMode === "exclude" || q.aiHiddenMode === "include" || q.aiHiddenMode === "only") {
    f.aiHiddenMode = q.aiHiddenMode;
  } else if (q.showAiHidden === true) {
    f.aiHiddenMode = "include";
  }
  if (q.albumScopeId !== undefined && Number(q.albumScopeId) > 0) {
    f.albumScopeId = Number(q.albumScopeId);
  }
  return f;
}

/**
 * Build an array of SQL conditions (to be combined via `and(...)`) for the
 * given filter. Relies on the caller's query having `photos` and a left‑join
 * to `photo_curation` for the current user under their normal aliases.
 */
export function buildPhotoFilterConditions(
  userId: number,
  filter: PhotoFilterParams
): SQL[] {
  const conds: SQL[] = [];

  const mode = filter.hiddenMode ?? "exclude";
  if (mode === "exclude") {
    conds.push(sql`COALESCE(${photoCuration.status}, 'visible') <> 'hidden'`);
  } else if (mode === "only") {
    conds.push(sql`${photoCuration.status} = 'hidden'`);
  }

  if (filter.favorite) {
    conds.push(sql`${photoCuration.status} = 'favorite'`);
  }

  if (filter.groupHighlight) {
    conds.push(sql`EXISTS (
      SELECT 1 FROM ${photoGroups} pg
      WHERE pg.user_id = ${userId} AND pg.cover_photo_id = ${photos.id}
    )`);
  }

  if (filter.albumHighlight) {
    conds.push(sql`EXISTS (
      SELECT 1 FROM ${albums} a
      LEFT JOIN ${albumShares} s ON s.album_id = a.id AND s.user_id = ${userId}
      WHERE a.cover_photo_id = ${photos.id}
        AND (a.user_id = ${userId} OR s.user_id IS NOT NULL)
    )`);
  }

  if (filter.inGroup) {
    conds.push(sql`EXISTS (
      SELECT 1 FROM ${photoGroupMembers} pgm
      JOIN ${photoGroups} pg ON pgm.group_id = pg.id
      WHERE pgm.photo_id = ${photos.id} AND pg.user_id = ${userId}
    )`);
  }

  if (filter.othersFavorited) {
    conds.push(sql`EXISTS (
      SELECT 1 FROM ${photoCuration} pc
      JOIN ${albumPhotos} ap ON ap.photo_id = pc.photo_id
      JOIN ${albums} a ON a.id = ap.album_id
      LEFT JOIN ${albumShares} s ON s.album_id = a.id AND s.user_id = ${userId}
      WHERE pc.photo_id = ${photos.id}
        AND pc.user_id <> ${userId}
        AND pc.status = 'favorite'
        AND (a.user_id = ${userId} OR s.user_id IS NOT NULL)
    )`);
  }

  if (filter.othersHidden) {
    conds.push(sql`EXISTS (
      SELECT 1 FROM ${photoCuration} pc
      JOIN ${albumPhotos} ap ON ap.photo_id = pc.photo_id
      JOIN ${albums} a ON a.id = ap.album_id
      LEFT JOIN ${albumShares} s ON s.album_id = a.id AND s.user_id = ${userId}
      WHERE pc.photo_id = ${photos.id}
        AND pc.user_id <> ${userId}
        AND pc.status = 'hidden'
        AND (a.user_id = ${userId} OR s.user_id IS NOT NULL)
    )`);
  }

  if (filter.qualityMin !== undefined) {
    conds.push(sql`${photos.ai_quality_score} >= ${filter.qualityMin / 100}`);
  }
  if (filter.qualityMax !== undefined) {
    conds.push(sql`${photos.ai_quality_score} <= ${filter.qualityMax / 100}`);
  }

  if (filter.notInAnyAlbum) {
    conds.push(sql`NOT EXISTS (
      SELECT 1 FROM ${albumPhotos} ap WHERE ap.photo_id = ${photos.id}
    )`);
  }

  if (filter.albumIds && filter.albumIds.length > 0) {
    const m = filter.albumMode ?? "include";
    const idList = sql.join(
      filter.albumIds.map((id) => sql`${id}`),
      sql`, `
    );
    const clause = sql`${photos.id} IN (
      SELECT ap.photo_id FROM ${albumPhotos} ap
      WHERE ap.album_id IN (${idList})
    )`;
    conds.push(m === "include" ? clause : sql`NOT (${clause})`);
  }

  if (filter.personIds && filter.personIds.length > 0) {
    const m = filter.personMode ?? "include";
    const idList = sql.join(
      filter.personIds.map((id) => sql`${id}`),
      sql`, `
    );
    const clause = sql`EXISTS (
      SELECT 1 FROM ${faces} f
      JOIN ${userFaceAssignments} ufa
        ON ufa.face_id = f.id AND ufa.user_id = ${userId}
      WHERE f.photo_id = ${photos.id}
        AND ufa.ignored = false
        AND ufa.person_id IN (${idList})
    )`;
    conds.push(m === "include" ? clause : sql`NOT (${clause})`);
  }

  if (filter.mediaTypes && filter.mediaTypes.length > 0) {
    const patterns: SQL[] = [];
    for (const t of filter.mediaTypes) {
      switch (t) {
        case "photo":
          // HEIC/HEIF zählen zu Fotos; nur RAW (image/x-*) wird ausgeschlossen.
          patterns.push(
            sql`(${photos.mime_type} LIKE 'image/%' AND ${photos.mime_type} NOT LIKE 'image/x-%')`
          );
          break;
        case "video":
          patterns.push(sql`${photos.mime_type} LIKE 'video/%'`);
          break;
        case "raw":
          patterns.push(sql`${photos.mime_type} LIKE 'image/x-%'`);
          break;
      }
    }
    if (patterns.length > 0) {
      conds.push(sql`(${sql.join(patterns, sql` OR `)})`);
    }
  }

  if (filter.hasGps === true) {
    conds.push(sql`${photos.latitude} IS NOT NULL AND ${photos.longitude} IS NOT NULL`);
  } else if (filter.hasGps === false) {
    conds.push(sql`(${photos.latitude} IS NULL OR ${photos.longitude} IS NULL)`);
  }

  if (filter.hasFaces !== undefined) {
    const existsFaces = sql`EXISTS (SELECT 1 FROM ${faces} f WHERE f.photo_id = ${photos.id})`;
    conds.push(filter.hasFaces ? existsFaces : sql`NOT (${existsFaces})`);
  }

  if (filter.hasAssignedPerson !== undefined) {
    const existsAssigned = sql`EXISTS (
      SELECT 1 FROM ${faces} f
      JOIN ${userFaceAssignments} ufa
        ON ufa.face_id = f.id AND ufa.user_id = ${userId}
      WHERE f.photo_id = ${photos.id}
        AND ufa.ignored = false
        AND ufa.person_id IS NOT NULL
    )`;
    conds.push(filter.hasAssignedPerson ? existsAssigned : sql`NOT (${existsAssigned})`);
  }

  if (filter.dateFrom) {
    conds.push(
      sql`COALESCE(${photos.taken_at}, ${photos.created_at}) >= ${filter.dateFrom}::timestamp`
    );
  }
  if (filter.dateTo) {
    conds.push(
      sql`COALESCE(${photos.taken_at}, ${photos.created_at}) < (${filter.dateTo}::timestamp + interval '1 day')`
    );
  }

  if (filter.importedDaysAgo !== undefined && filter.importedDaysAgo > 0) {
    conds.push(
      sql`${photos.created_at} >= NOW() - (${filter.importedDaysAgo} * interval '1 day')`
    );
  }

  if (filter.sizeMin !== undefined) {
    conds.push(sql`${photos.size} >= ${filter.sizeMin}`);
  }
  if (filter.sizeMax !== undefined) {
    conds.push(sql`${photos.size} <= ${filter.sizeMax}`);
  }

  // AI auto-pick visibility filter (Track I). A photo is "AI-hidden"
  // when it is a member of a HIGH-confidence AI-picked group that the
  // user has not yet reviewed and the photo itself is NOT one of the
  // AI's picks. Medium / low confidence groups never auto-hide so the
  // user always sees the runner-ups; reviewed groups respect the user's
  // own hide decisions exclusively.
  const aiMode = filter.aiHiddenMode ?? "exclude";
  const aiHiddenExists = sql`EXISTS (
    SELECT 1 FROM ${photoGroupMembers} pgm_ai
    JOIN ${photoGroups} pg_ai ON pg_ai.id = pgm_ai.group_id
    WHERE pgm_ai.photo_id = ${photos.id}
      AND pg_ai.user_id = ${userId}
      AND pg_ai.reviewed_at IS NULL
      AND pg_ai.ai_picked_at IS NOT NULL
      AND pg_ai.ai_picked_confidence = 'high'
      AND NOT (${photos.id} = ANY(pg_ai.ai_picked_photo_ids))
  )`;
  if (aiMode === "exclude") {
    conds.push(sql`NOT (${aiHiddenExists})`);
  } else if (aiMode === "only") {
    conds.push(aiHiddenExists);
  }

  return conds;
}
