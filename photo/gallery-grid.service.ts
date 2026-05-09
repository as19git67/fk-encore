/**
 * Backend logic for the virtualized photo gallery grid.
 *
 * Goals (deliberately divergent from the legacy /photos/index):
 *   - Server is the only place that touches the user's full photo list.
 *     The client never iterates anything global — it only reads the
 *     `total` count and a window of rows.
 *   - Each row is pre-enriched with everything the grid needs to render:
 *     thumbnail filename, square crop offset, curation status, and
 *     similar-photo group info (id, member count, is_cover, reviewed).
 *     No second roundtrip to /photos/groups, no client-side mapping.
 *   - Window-around-target ("aroundPhotoId") locates the photo's position
 *     in the filtered+sorted result and returns a window centered on it
 *     so the gallery can `scrollToOffset` directly without a guess.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import { photos, photoCuration, photoGroupMembers, photoGroups } from "../db/schema";
import {
  buildPhotoFilterConditions,
  type PhotoFilterParams,
} from "./photo.filters";
import type {
  GalleryGridEntry,
  GalleryGridGroup,
  GalleryGridResponse,
  CurationStatus,
} from "../db/types";

export type GallerySortField =
  | "taken_at"
  | "created_at"
  | "ai_quality_score"
  | "filename"
  | "size";

export type GallerySortDir = "asc" | "desc";

const VALID_SORT_FIELDS = new Set<GallerySortField>([
  "taken_at",
  "created_at",
  "ai_quality_score",
  "filename",
  "size",
]);

export function normalizeGallerySortField(raw: string | undefined): GallerySortField {
  return raw && VALID_SORT_FIELDS.has(raw as GallerySortField)
    ? (raw as GallerySortField)
    : "taken_at";
}

export function normalizeGallerySortDir(raw: string | undefined): GallerySortDir {
  return raw === "desc" ? "desc" : "asc";
}

/**
 * COALESCE(taken_at, created_at) — fallback to upload date if no EXIF date
 * is available. Same fragment as legacy code but local to this module so the
 * service does not have to import private internals.
 */
const photoDateOrder = sql`COALESCE(${photos.taken_at}, ${photos.created_at})`;

/** SQL fragment producing the value sorted by, given a sort field. */
function sortKeyExpr(field: GallerySortField) {
  switch (field) {
    case "taken_at":
      return photoDateOrder;
    case "created_at":
      return sql`${photos.created_at}`;
    case "ai_quality_score":
      return sql`${photos.ai_quality_score}`;
    case "filename":
      return sql`${photos.filename}`;
    case "size":
      return sql`${photos.size}`;
  }
}

/** ORDER BY clauses for the grid query, with deterministic id tie-break. */
function orderByClauses(field: GallerySortField, dir: GallerySortDir) {
  const key = sortKeyExpr(field);
  // NULLS LAST regardless of direction. Most importantly for ai_quality_score
  // — ASC by quality should not flood the head of the list with the
  // not-yet-scored photos.
  const dirSql = dir === "asc" ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`;
  const idDir = dir === "asc" ? sql`ASC` : sql`DESC`;
  return [sql`${key} ${dirSql}`, sql`${photos.id} ${idDir}`];
}

/**
 * Locate a single photo's position (0-based) in the user's filtered+sorted
 * gallery. Returns `null` if the photo does not exist or is filtered out.
 *
 * Implemented as "count rows that come before the target" so the planner can
 * use indexes on the sort column instead of materialising a window function
 * over the full result set. The lexicographic comparison (sort_key, id)
 * mirrors the secondary id tie-break in `orderByClauses` so two photos
 * sharing a sort-key value still get a deterministic position.
 */
export async function locateGalleryPhotoPosition(
  userId: number,
  filter: PhotoFilterParams,
  photoId: number,
  sortBy: GallerySortField,
  sortDir: GallerySortDir,
): Promise<number | null> {
  const targetRow = await dbFirst<{ id: number; sort_key: string | number | null }>(
    db
      .select({ id: photos.id, sort_key: sortKeyExpr(sortBy) })
      .from(photos)
      .where(and(eq(photos.id, photoId), eq(photos.user_id, userId))),
  );
  if (!targetRow) return null;

  const filterConds = buildPhotoFilterConditions(userId, filter);
  const baseWhere = and(eq(photos.user_id, userId), ...filterConds);

  const targetKey = targetRow.sort_key;
  const sortKey = sortKeyExpr(sortBy);

  let beforeCondition;
  if (sortDir === "asc") {
    if (targetKey === null) {
      // ASC + NULLS LAST: only NULL rows with smaller id precede a NULL target.
      beforeCondition = sql`(${sortKey} IS NOT NULL OR (${sortKey} IS NULL AND ${photos.id} < ${photoId}))`;
    } else {
      beforeCondition = sql`(${sortKey} < ${targetKey} OR (${sortKey} = ${targetKey} AND ${photos.id} < ${photoId}))`;
    }
  } else {
    if (targetKey === null) {
      beforeCondition = sql`(${sortKey} IS NOT NULL OR (${sortKey} IS NULL AND ${photos.id} > ${photoId}))`;
    } else {
      beforeCondition = sql`(${sortKey} > ${targetKey} OR (${sortKey} = ${targetKey} AND ${photos.id} > ${photoId}))`;
    }
  }

  const row = await dbFirst<{ c: number }>(
    db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(photos)
      .leftJoin(
        photoCuration,
        and(eq(photos.id, photoCuration.photo_id), eq(photoCuration.user_id, userId)),
      )
      .where(and(baseWhere, beforeCondition)),
  );
  return row?.c ?? 0;
}

/**
 * Return a window of grid entries with `total` and `offset`. Used by the
 * virtualized client gallery — see `useGallerySource`.
 *
 * - `aroundPhotoId` (when `offset` is not given): center the window on
 *   that photo. Server runs a locate query to compute the offset and clamps
 *   the window to fit `[0, total - limit]`.
 * - `offset` wins when both are supplied — explicit pagination is needed
 *   for the client's edge-load follow-ups.
 *
 * Group info is inlined per-row via a correlated subquery that picks ONE
 * group per photo, preferring unreviewed groups over reviewed ones. With
 * the typical ratio of "few photos in groups, most not", this is cheap
 * because the subquery LIMIT 1 short-circuits on the empty case.
 */
export async function listGalleryGridLogic(
  userId: number,
  filter: PhotoFilterParams,
  pagination: {
    limit: number;
    offset?: number;
    sortBy: GallerySortField;
    sortDir: GallerySortDir;
    aroundPhotoId?: number;
    /**
     * Optional explicit ID set. When supplied, the result is restricted to
     * these photos and ordered by their position in this array — used for
     * natural-language search where ranking is the search engine's, not
     * the date / quality / filename sort. Filters still apply.
     */
    photoIds?: number[];
  },
): Promise<GalleryGridResponse> {
  const filterConds = buildPhotoFilterConditions(userId, filter);
  const photoIdFilter = pagination.photoIds && pagination.photoIds.length > 0
    ? inArray(photos.id, pagination.photoIds)
    : undefined;
  const whereClause = and(
    eq(photos.user_id, userId),
    ...filterConds,
    ...(photoIdFilter ? [photoIdFilter] : []),
  );
  // When a photoIds list is provided, preserve its order via array_position.
  // Otherwise, fall back to the requested column sort with id tie-break.
  const orderBy = pagination.photoIds && pagination.photoIds.length > 0
    ? [sql`array_position(${sql.raw(`ARRAY[${pagination.photoIds.join(",")}]::int[]`)}, ${photos.id})`]
    : orderByClauses(pagination.sortBy, pagination.sortDir);

  // total — always returned, drives the virtualizer's row count.
  const countRow = await dbFirst<{ c: number }>(
    db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(photos)
      .leftJoin(
        photoCuration,
        and(eq(photos.id, photoCuration.photo_id), eq(photoCuration.user_id, userId)),
      )
      .where(whereClause),
  );
  const total = countRow?.c ?? 0;

  // Resolve offset — precedence:
  //   1. explicit `offset` (used for back-fill / scroll-edge fetches)
  //   2. `aroundPhotoId`  (window centered on a target photo)
  //   3. default differs by mode:
  //        - normal sort: last page (so opening the gallery lands on the
  //          newest photo in an ASC-by-date sort)
  //        - photoIds (search): first page (offset 0) — the top result is
  //          the most relevant and that's what the user wants to see.
  let resolvedOffset: number;
  if (pagination.offset !== undefined && pagination.offset >= 0) {
    resolvedOffset = pagination.offset;
  } else if (pagination.aroundPhotoId !== undefined && total > 0) {
    let pos: number | null = null;
    if (pagination.photoIds && pagination.photoIds.length > 0) {
      // Search mode: position is just the photo's index in the input list
      // (or null if it isn't a search hit, in which case we let the
      // fallback below kick in).
      const idx = pagination.photoIds.indexOf(pagination.aroundPhotoId);
      pos = idx >= 0 ? idx : null;
    } else {
      pos = await locateGalleryPhotoPosition(
        userId,
        filter,
        pagination.aroundPhotoId,
        pagination.sortBy,
        pagination.sortDir,
      );
    }
    if (pos !== null) {
      const half = Math.floor(pagination.limit / 2);
      const maxOffset = Math.max(0, total - pagination.limit);
      resolvedOffset = Math.max(0, Math.min(pos - half, maxOffset));
    } else {
      // Photo no longer exists / filtered out — sensible default per mode.
      resolvedOffset = pagination.photoIds && pagination.photoIds.length > 0
        ? 0
        : Math.max(0, total - pagination.limit);
    }
  } else {
    resolvedOffset = pagination.photoIds && pagination.photoIds.length > 0
      ? 0
      : Math.max(0, total - pagination.limit);
  }

  if (total === 0) {
    return { total: 0, offset: 0, photos: [] };
  }

  const rows = await dbAll<{
    id: number;
    filename: string;
    auto_crop: { x: number; y: number } | null;
    curation_status: string | null;
  }>(
    db
      .select({
        id: photos.id,
        filename: photos.filename,
        auto_crop: photos.auto_crop,
        curation_status: photoCuration.status,
      })
      .from(photos)
      .leftJoin(
        photoCuration,
        and(eq(photos.id, photoCuration.photo_id), eq(photoCuration.user_id, userId)),
      )
      .where(whereClause)
      .orderBy(...orderBy)
      .limit(pagination.limit)
      .offset(resolvedOffset),
  );

  // Group info is hydrated in two scoped queries against the returned page
  // instead of a correlated subquery per row. This keeps the main SELECT
  // free of nested scans and turns the group lookup into O(page_size + N
  // distinct groups) regardless of how many groups the user has.
  // Preferring unreviewed-then-highest-id mirrors the legacy server-side
  // ordering and is enforced by the DISTINCT ON sort key.
  const photoIds = rows.map((r) => r.id);
  const groupByPhotoId = await loadGroupInfoForPhotos(userId, photoIds);

  const result: GalleryGridEntry[] = rows.map((r) => {
    const entry: GalleryGridEntry = {
      id: r.id,
      filename: r.filename,
      curation: (r.curation_status as CurationStatus) ?? "visible",
    };
    if (r.auto_crop) entry.auto_crop = r.auto_crop;
    const g = groupByPhotoId.get(r.id);
    if (g) entry.group = g;
    return entry;
  });

  return { total, offset: resolvedOffset, photos: result };
}

/**
 * For a given page of photo ids, return the chosen group per photo (preferring
 * unreviewed groups, tie-break by highest group id). Splits the work into two
 * cheap, index-friendly queries instead of running a correlated subquery per
 * row of the main SELECT:
 *
 *   1. DISTINCT ON over photo_group_members joined with photo_groups, scoped
 *      to the returned photo_ids — yields at most one (photo_id, group) pair
 *      per photo. Uses the photo_group_members(photo_id) index.
 *   2. GROUP BY count over photo_group_members for the small set of group_ids
 *      that survived step 1 — uses the (group_id, photo_id) PK directly.
 *
 * Returns an empty map when the page contains no photos.
 */
async function loadGroupInfoForPhotos(
  userId: number,
  photoIds: number[],
): Promise<Map<number, GalleryGridGroup>> {
  const out = new Map<number, GalleryGridGroup>();
  if (photoIds.length === 0) return out;

  const chosenResult = await db.execute<{
    photo_id: number;
    group_id: number;
    is_cover: boolean;
    reviewed: boolean;
  }>(sql`
    SELECT DISTINCT ON (pgm.photo_id)
      pgm.photo_id AS photo_id,
      g.id AS group_id,
      (g.cover_photo_id = pgm.photo_id) AS is_cover,
      (g.reviewed_at IS NOT NULL) AS reviewed
    FROM ${photoGroupMembers} pgm
    JOIN ${photoGroups} g ON g.id = pgm.group_id
    WHERE pgm.photo_id = ANY(${photoIds}::int[])
      AND g.user_id = ${userId}
    ORDER BY pgm.photo_id, (g.reviewed_at IS NULL) DESC, g.id DESC
  `);
  const chosen = chosenResult.rows;
  if (chosen.length === 0) return out;

  const groupIds = Array.from(new Set(chosen.map((c) => c.group_id)));
  const countsResult = await db.execute<{ group_id: number; member_count: number }>(sql`
    SELECT group_id, COUNT(*)::int AS member_count
    FROM ${photoGroupMembers}
    WHERE group_id = ANY(${groupIds}::int[])
    GROUP BY group_id
  `);
  const counts = countsResult.rows;
  const memberCountByGroupId = new Map<number, number>();
  for (const c of counts) memberCountByGroupId.set(c.group_id, c.member_count);

  for (const c of chosen) {
    out.set(c.photo_id, {
      id: c.group_id,
      is_cover: c.is_cover,
      member_count: memberCountByGroupId.get(c.group_id) ?? 0,
      reviewed: c.reviewed,
    });
  }
  return out;
}
