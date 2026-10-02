/**
 * Orientation variants: portrait and landscape of the same motif
 * (.claude/plans/orientierungs-varianten.md, Stage 1).
 *
 * Of one motif there is often a portrait and a landscape frame, a few seconds
 * apart. Both are wanted, but on a rotated screen one of them always fits
 * badly. Photos that show the same motif in both formats form a *format
 * group*; every view shows only the side that matches the screen orientation,
 * the other side sits one tap away.
 *
 * The format group is a *view*, not a hide: nothing is written to
 * photo_curation, counters stay honest, and the selection mode sees
 * everything. Membership is derived from the similarity groups
 * (`photo_groups`) that already say "same motif":
 *
 *   - the group has at least one portrait and one landscape member
 *     (`square` never counts, unknown dimensions never count),
 *   - those members are visible for this user (not `hidden`),
 *   - a member belongs to the format group only if a visible member of the
 *     *other* orientation was taken within `VARIANT_TIME_WINDOW_SECONDS`,
 *   - the group is not switched `off` by the user,
 *   - and the user's global switch `collapse_orientation_variants` is on.
 *
 * Two places need the same answer: the SQL filter on the gallery grid
 * (`orientationVariantSuppressedSql`, applied in photo.filters.ts) and the
 * per-group summary in TypeScript (`computeOrientationVariants`). Keep the two
 * rules in sync — the unit tests in orientation-variants.test.ts pin both.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbExec, dbFirst } from "../db/adapter";
import { photoCuration, photoGroupMembers, photoGroups, photos, users } from "../db/schema";
import type {
  OrientationVariantCounts,
  OrientationVariantsMode,
  PhotoOrientation,
} from "../db/types";

/**
 * Maximum distance in time between a portrait and a landscape frame for them
 * to count as two formats of *one* shot. Deliberately much tighter than the
 * grouping window (TIME_WINDOW_SECONDS in photo.service.ts, ten minutes):
 * that one separates "same place, same hour"; this one separates "I turned
 * the camera" from "I came back later".
 */
export const VARIANT_TIME_WINDOW_SECONDS = 120;

/** Same aspect-ratio bands as `classifyOrientation` in group-auto-pick.ts. */
const LANDSCAPE_MIN_RATIO = 1.1;
const PORTRAIT_MAX_RATIO = 0.9;

/**
 * Orientation from pixel dimensions, or null while the dimensions are
 * unknown. Unlike `classifyOrientation` (which defaults to landscape so the
 * AI pick's diversity rule becomes a no-op), the API must say "unknown"
 * honestly: a photo without dimensions never forms a format group.
 */
export function photoOrientation(
  width: number | null | undefined,
  height: number | null | undefined,
): PhotoOrientation | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const ratio = width / height;
  if (ratio > LANDSCAPE_MIN_RATIO) return "landscape";
  if (ratio < PORTRAIT_MAX_RATIO) return "portrait";
  return "square";
}

export function oppositeOrientation(side: "portrait" | "landscape"): "portrait" | "landscape" {
  return side === "portrait" ? "landscape" : "portrait";
}

/** What `computeOrientationVariants` needs to know about one member. */
export interface VariantMember {
  photo_id: number;
  width: number | null;
  height: number | null;
  /** ISO timestamp or null; a member without one never joins a format group. */
  taken_at: string | null;
  /** True when the member is hidden for this user (curation status). */
  hidden: boolean;
}

export interface OrientationVariantsResult {
  /** Visible members per side that belong to the format group. */
  counts: OrientationVariantCounts;
  /** Ids of the members that belong to the format group, per side. */
  portraitIds: number[];
  landscapeIds: number[];
}

function takenAtMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Decide whether a group currently forms a format group and which members
 * belong to it. Returns null when it does not (one side missing, everything
 * too far apart, dimensions unknown, or `mode === "off"`).
 *
 * The rule is per member, not per group: a landscape frame belongs when some
 * visible portrait frame was taken within the window, and vice versa. With
 * 3 portrait + 2 landscape frames all within two minutes, all five belong —
 * the view shows one whole side, it does not pair ("Seite zeigen, nicht
 * paaren").
 */
export function computeOrientationVariants(
  members: VariantMember[],
  mode: OrientationVariantsMode | string | null | undefined,
): OrientationVariantsResult | null {
  if (mode === "off") return null;
  const windowMs = VARIANT_TIME_WINDOW_SECONDS * 1000;
  const portrait: { id: number; t: number }[] = [];
  const landscape: { id: number; t: number }[] = [];
  for (const m of members) {
    if (m.hidden) continue;
    const t = takenAtMs(m.taken_at);
    if (t === null) continue;
    const o = photoOrientation(m.width, m.height);
    if (o === "portrait") portrait.push({ id: m.photo_id, t });
    else if (o === "landscape") landscape.push({ id: m.photo_id, t });
  }
  if (portrait.length === 0 || landscape.length === 0) return null;

  const near = (a: { t: number }, others: { t: number }[]) =>
    others.some((b) => Math.abs(a.t - b.t) <= windowMs);
  const portraitIds = portrait.filter((p) => near(p, landscape)).map((p) => p.id);
  const landscapeIds = landscape.filter((l) => near(l, portrait)).map((l) => l.id);
  if (portraitIds.length === 0 || landscapeIds.length === 0) return null;
  return {
    counts: { portrait: portraitIds.length, landscape: landscapeIds.length },
    portraitIds,
    landscapeIds,
  };
}

/**
 * SQL: the aspect-ratio test for one side, over arbitrary width/height
 * expressions. NULL-safe on purpose: unknown dimensions must yield FALSE, not
 * NULL — a NULL here would turn the outer `NOT (...)` into NULL and silently
 * drop every photo without dimensions from the grid.
 */
function orientationSql(width: SQL, height: SQL, side: "portrait" | "landscape"): SQL {
  const known = sql`(COALESCE(${width}, 0) > 0 AND COALESCE(${height}, 0) > 0)`;
  const ratio = sql`(${width}::float / NULLIF(${height}, 0)::float)`;
  return side === "landscape"
    ? sql`(${known} AND ${ratio} > ${LANDSCAPE_MIN_RATIO})`
    : sql`(${known} AND ${ratio} < ${PORTRAIT_MAX_RATIO})`;
}

/**
 * SQL predicate: "this photo is the *other* side of a format group while the
 * list shows `side`". Relies on the caller's query having `photos` and the
 * left-join to `photo_curation` for `userId` under their normal aliases,
 * exactly like the other conditions in `buildPhotoFilterConditions`.
 *
 * Mirrors `computeOrientationVariants` member by member: the photo has the
 * opposite orientation, is visible, has a taken_at, and shares a group (not
 * switched off, owned by this user) with a visible member of `side` taken
 * within the window. The user's global switch is folded in, so a caller never
 * has to look it up separately.
 */
export function orientationVariantSuppressedSql(
  userId: number,
  side: "portrait" | "landscape",
): SQL {
  const other = oppositeOrientation(side);
  return sql`(
    ${orientationSql(sql`${photos.width}`, sql`${photos.height}`, other)}
    AND ${photos.taken_at} IS NOT NULL
    AND COALESCE(${photoCuration.status}, 'visible') <> 'hidden'
    AND EXISTS (
      SELECT 1 FROM ${users} u_ov
      WHERE u_ov.id = ${userId} AND u_ov.collapse_orientation_variants
    )
    AND EXISTS (
      SELECT 1
      FROM ${photoGroupMembers} pgm_ov
      JOIN ${photoGroups} pg_ov ON pg_ov.id = pgm_ov.group_id
      JOIN ${photoGroupMembers} pgm_ov2
        ON pgm_ov2.group_id = pg_ov.id AND pgm_ov2.photo_id <> ${photos.id}
      JOIN ${photos} p_ov ON p_ov.id = pgm_ov2.photo_id
      LEFT JOIN ${photoCuration} pc_ov
        ON pc_ov.photo_id = p_ov.id AND pc_ov.user_id = ${userId}
      WHERE pgm_ov.photo_id = ${photos.id}
        AND pg_ov.user_id = ${userId}
        AND pg_ov.orientation_variants IS DISTINCT FROM 'off'
        AND COALESCE(pc_ov.status, 'visible') <> 'hidden'
        AND ${orientationSql(sql`p_ov.width`, sql`p_ov.height`, side)}
        AND p_ov.taken_at IS NOT NULL
        AND ABS(EXTRACT(EPOCH FROM (p_ov.taken_at - ${photos.taken_at}))) <= ${VARIANT_TIME_WINDOW_SECONDS}
    )
  )`;
}

// ── Settings ───────────────────────────────────────────────────────────────

export interface GroupOrientationVariantsResult {
  success: boolean;
  mode: OrientationVariantsMode;
}

/**
 * "Nicht dasselbe Motiv" / "Als Formatpaar behandeln" on one group. Only the
 * owner of the group can flip it; the group is theirs by `user_id`. No
 * dialog, immediately reversible — the caller just sends the other mode.
 */
export async function setGroupOrientationVariantsLogic(
  userId: number,
  groupId: number,
  mode: OrientationVariantsMode,
): Promise<GroupOrientationVariantsResult> {
  if (mode !== "auto" && mode !== "off") {
    throw APIError.invalidArgument("mode must be 'auto' or 'off'");
  }
  const group = await dbFirst<{ id: number }>(
    db.select({ id: photoGroups.id })
      .from(photoGroups)
      .where(and(eq(photoGroups.id, groupId), eq(photoGroups.user_id, userId))),
  );
  if (!group) throw APIError.notFound("group not found");
  await dbExec(
    db.update(photoGroups)
      .set({ orientation_variants: mode })
      .where(eq(photoGroups.id, groupId)),
  );
  return { success: true, mode };
}

export interface CollapseOrientationVariantsSettings {
  enabled: boolean;
}

/** The user's global switch, as shown under Photos › Settings. */
export async function getCollapseOrientationVariantsLogic(
  userId: number,
): Promise<CollapseOrientationVariantsSettings> {
  const row = await dbFirst<{ enabled: boolean }>(
    db.select({ enabled: users.collapse_orientation_variants })
      .from(users)
      .where(eq(users.id, userId)),
  );
  return { enabled: row?.enabled ?? true };
}

/**
 * Flip the global switch. Takes effect on the next list request; nothing is
 * materialised, so there is nothing to revert or re-run.
 */
export async function setCollapseOrientationVariantsLogic(
  userId: number,
  enabled: boolean,
): Promise<CollapseOrientationVariantsSettings> {
  await dbExec(
    db.update(users)
      .set({ collapse_orientation_variants: enabled })
      .where(eq(users.id, userId)),
  );
  return { enabled };
}
