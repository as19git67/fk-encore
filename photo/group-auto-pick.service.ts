/**
 * Service helpers for the AI auto-pick on similar photo groups.
 *
 * Stays out of photo.service.ts to keep the 5000+ line god-module from
 * growing further, and so the SQL-aggregation + persist logic can be
 * exercised by integration tests independently of the embedding service.
 *
 * Public surface:
 *   recomputeAiPicksForGroups()  — score every unreviewed group of the
 *                                  given IDs, write back ai_picked_*
 *                                  fields. Idempotent.
 *   recomputeAiPicksForUser()    — same but for every unreviewed group
 *                                  of the user. Used after find-groups.
 *   acceptAiPick()               — turn the AI suggestion into a real
 *                                  user review: hide every non-picked
 *                                  member via photo_curation, which in
 *                                  turn auto-sets photo_groups.reviewed_at
 *                                  via the existing hide-cascade.
 *   bulkAcceptHighConfidencePicks() — same, applied to every unreviewed
 *                                  high-confidence group of the user.
 *   exportCalibrationDataset()   — produce the per-(group, photo) JSON
 *                                  used to calibrate weights in Stufe D.
 */

import { and, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec, dbFirst } from "../db/adapter";
import {
  faces,
  photoCuration,
  photoGroupMembers,
  photoGroups,
  photos,
  type AiPickDetails,
} from "../db/schema";
import {
  classifyOrientation,
  computeGroupPick,
  type AiConfidence,
  type Orientation,
  type PhotoSignals,
} from "./group-auto-pick";

interface PhotoSignalRow {
  photo_id: number;
  ai_quality_details: Record<string, number> | null;
  face_count: number;
  face_coverage: number;
  width: number | null;
  height: number | null;
}

/**
 * Load per-photo signal rows for a set of photo ids.
 *
 * Face-coverage is the sum of (width × height) over every detected face
 * in the photo. `faces.bbox` is a JSON string `{ x, y, width, height }`
 * with coordinates already normalised to [0, 1], so the product is the
 * fractional image area covered by faces. We do the JSON parse in SQL to
 * keep the round-trip a single query, falling back to 0 for any malformed
 * row (text column makes that defensible).
 */
async function loadSignalsForPhotos(photoIds: number[]): Promise<PhotoSignalRow[]> {
  if (photoIds.length === 0) return [];

  // Per-photo (photo_id, sum of bbox area) — left-joined onto photos so
  // photos without any face row produce face_count = 0, face_coverage = 0.
  // The COALESCE on the JSON cast tolerates legacy/manual rows that may
  // not be parseable JSON.
  const rows = await dbAll<PhotoSignalRow>(
    db.select({
      photo_id: photos.id,
      ai_quality_details: photos.ai_quality_details,
      face_count: sql<number>`COUNT(${faces.id})::int`,
      face_coverage: sql<number>`
        COALESCE(SUM(
          COALESCE(((${faces.bbox})::jsonb->>'width')::float, 0)
          *
          COALESCE(((${faces.bbox})::jsonb->>'height')::float, 0)
        ), 0)::float
      `,
      width: photos.width,
      height: photos.height,
    })
      .from(photos)
      .leftJoin(faces, eq(faces.photo_id, photos.id))
      .where(inArray(photos.id, photoIds))
      .groupBy(photos.id),
  );
  return rows;
}

/** Translate one SQL row into the input shape consumed by computeGroupPick. */
function toPhotoSignals(row: PhotoSignalRow): PhotoSignals {
  const d = row.ai_quality_details ?? {};
  const orientation: Orientation | undefined =
    row.width != null && row.height != null
      ? classifyOrientation(row.width, row.height)
      : undefined;
  return {
    photo_id: row.photo_id,
    blur_score: typeof d.blur_score === "number" ? d.blur_score : null,
    contrast_score: typeof d.contrast_score === "number" ? d.contrast_score : null,
    exposure_score: typeof d.exposure_score === "number" ? d.exposure_score : null,
    clip_aesthetics: typeof d.clip_aesthetics === "number" ? d.clip_aesthetics : null,
    clip_composition: typeof d.clip_composition === "number" ? d.clip_composition : null,
    clip_technical: typeof d.clip_technical === "number" ? d.clip_technical : null,
    face_sharpness: typeof d.face_sharpness === "number" ? d.face_sharpness : null,
    eyes_open_score: typeof d.eyes_open_score === "number" ? d.eyes_open_score : null,
    face_count: row.face_count,
    face_coverage: row.face_coverage,
    orientation,
  };
}

export interface RecomputeResult {
  groups_scored: number;
  groups_skipped: number;
}

/**
 * Score every unreviewed group in `groupIds` (or every unreviewed group
 * of the user if not provided) and persist the result on photo_groups.
 *
 * Reviewed groups are skipped — once the user has decided, the KI keeps
 * its hands off. The query that drives this filter is the same one used
 * by the gallery filter (partial index 0075).
 */
export async function recomputeAiPicksForGroups(
  userId: number | undefined,
  groupIds?: number[],
): Promise<RecomputeResult> {
  const baseConds = [isNull(photoGroups.reviewed_at)];
  if (typeof userId === "number") {
    baseConds.push(eq(photoGroups.user_id, userId));
  }
  if (groupIds && groupIds.length > 0) {
    baseConds.push(inArray(photoGroups.id, groupIds));
  }
  const groups = await dbAll<{ id: number }>(
    db.select({ id: photoGroups.id }).from(photoGroups).where(and(...baseConds)),
  );
  if (groups.length === 0) {
    return { groups_scored: 0, groups_skipped: 0 };
  }

  const allIds = groups.map((g) => g.id);
  const members = await dbAll<{ group_id: number; photo_id: number }>(
    db.select({
      group_id: photoGroupMembers.group_id,
      photo_id: photoGroupMembers.photo_id,
    })
      .from(photoGroupMembers)
      .where(inArray(photoGroupMembers.group_id, allIds)),
  );
  const byGroup = new Map<number, number[]>();
  for (const m of members) {
    const arr = byGroup.get(m.group_id);
    if (arr) arr.push(m.photo_id);
    else byGroup.set(m.group_id, [m.photo_id]);
  }
  // One signal-fetch covers every photo across every group in this batch.
  // For ~5k groups × ~10 photos this is 50k IDs — Postgres handles that
  // fine in a single IN() expansion and the alternative (per-group query)
  // would multiply the round-trip count by 5000.
  const distinctPhotoIds = Array.from(new Set(members.map((m) => m.photo_id)));
  const signalRows = await loadSignalsForPhotos(distinctPhotoIds);
  const signalByPhotoId = new Map<number, PhotoSignals>();
  for (const row of signalRows) {
    signalByPhotoId.set(row.photo_id, toPhotoSignals(row));
  }

  let scored = 0;
  let skipped = 0;
  const nowSql = sql`NOW()`;
  for (const { id: groupId } of groups) {
    const photoIds = byGroup.get(groupId) ?? [];
    if (photoIds.length < 2) {
      skipped++;
      continue;
    }
    const groupSignals = photoIds.map((pid) =>
      signalByPhotoId.get(pid) ?? {
        photo_id: pid,
        face_count: 0,
        face_coverage: 0,
      },
    );
    const result = computeGroupPick(groupSignals);
    await dbExec(
      db.update(photoGroups)
        .set({
          ai_picked_photo_ids: result.picked_photo_ids,
          ai_picked_at: nowSql as any,
          ai_picked_confidence: result.confidence,
          ai_pick_details: result.details,
        })
        .where(eq(photoGroups.id, groupId)),
    );
    scored++;
  }
  return { groups_scored: scored, groups_skipped: skipped };
}

export function recomputeAiPicksForUser(userId: number): Promise<RecomputeResult> {
  return recomputeAiPicksForGroups(userId);
}

/**
 * Server-wide variant: scores every unreviewed group regardless of
 * owner. Used by the maintenance button so a single admin can seed
 * picks for all users in one click.
 */
export function recomputeAiPicksForAllUsers(): Promise<RecomputeResult> {
  return recomputeAiPicksForGroups(undefined);
}

/**
 * "User accepts the AI suggestion for this group" — copy the pick into a
 * real user review:
 *
 *   1. For every group member that is NOT in ai_picked_photo_ids, set
 *      photo_curation.status = 'hidden' for this user. The existing
 *      hide-cascade auto-marks photo_groups.reviewed_at once every
 *      member is hidden (see photo.service.ts:2562).
 *   2. Returns the count of newly hidden photos so the UI can show a
 *      "N versteckt" toast.
 *
 * Idempotent: photos already hidden stay hidden, picked photos are left
 * untouched (no implicit unhide — the user may have manually favorited
 * one of them).
 */
export async function acceptAiPickLogic(
  userId: number,
  groupId: number,
): Promise<{ success: boolean; hidden_count: number }> {
  const group = await dbFirst<{
    id: number;
    ai_picked_photo_ids: number[] | null;
    reviewed_at: string | null;
  }>(
    db.select({
      id: photoGroups.id,
      ai_picked_photo_ids: photoGroups.ai_picked_photo_ids,
      reviewed_at: photoGroups.reviewed_at,
    })
      .from(photoGroups)
      .where(and(eq(photoGroups.id, groupId), eq(photoGroups.user_id, userId))),
  );
  if (!group) return { success: false, hidden_count: 0 };
  if (group.reviewed_at) return { success: true, hidden_count: 0 };
  const picked = new Set(group.ai_picked_photo_ids ?? []);
  if (picked.size === 0) return { success: false, hidden_count: 0 };

  const members = await dbAll<{ photo_id: number }>(
    db.select({ photo_id: photoGroupMembers.photo_id })
      .from(photoGroupMembers)
      .where(eq(photoGroupMembers.group_id, groupId)),
  );
  const toHide = members.map((m) => m.photo_id).filter((pid) => !picked.has(pid));
  if (toHide.length === 0) {
    // All members are picked. Mark reviewed so the group leaves the
    // unreviewed queue but don't hide anything.
    await dbExec(
      db.update(photoGroups)
        .set({ reviewed_at: new Date().toISOString() })
        .where(eq(photoGroups.id, groupId)),
    );
    return { success: true, hidden_count: 0 };
  }

  // Upsert hidden status for every non-picked member. ON CONFLICT keeps
  // a manual 'favorite' from being clobbered into 'hidden' — accepting
  // an AI suggestion must never undo a deliberate user action.
  const nowIso = new Date().toISOString();
  for (const photoId of toHide) {
    await db.execute(sql`
      INSERT INTO photo_curation (user_id, photo_id, status, updated_at)
      VALUES (${userId}, ${photoId}, 'hidden', ${nowIso})
      ON CONFLICT (user_id, photo_id) DO UPDATE
        SET status = CASE
              WHEN photo_curation.status = 'favorite' THEN 'favorite'
              ELSE 'hidden'
            END,
            updated_at = EXCLUDED.updated_at
    `);
  }

  // Belt-and-braces: hide-cascade in setPhotoCurationStatus only fires on
  // its own update path. We're updating photo_curation directly, so mark
  // the group reviewed here too.
  await dbExec(
    db.update(photoGroups)
      .set({ reviewed_at: nowIso })
      .where(eq(photoGroups.id, groupId)),
  );

  return { success: true, hidden_count: toHide.length };
}

export interface BulkAcceptResult {
  groups_accepted: number;
  hidden_count: number;
}

/**
 * Bulk-accept every unreviewed high-confidence AI pick of the user. Used
 * by the "Alle hochkonfidenten KI-Picks bestätigen" button in
 * DataManagementView for the initial rollout against ~5k groups.
 */
export async function bulkAcceptHighConfidencePicksLogic(
  userId: number,
): Promise<BulkAcceptResult> {
  const groups = await dbAll<{ id: number }>(
    db.select({ id: photoGroups.id })
      .from(photoGroups)
      .where(and(
        eq(photoGroups.user_id, userId),
        isNull(photoGroups.reviewed_at),
        isNotNull(photoGroups.ai_picked_at),
        eq(photoGroups.ai_picked_confidence, "high"),
      )),
  );
  let accepted = 0;
  let hidden = 0;
  for (const { id } of groups) {
    const result = await acceptAiPickLogic(userId, id);
    if (result.success) {
      accepted++;
      hidden += result.hidden_count;
    }
  }
  return { groups_accepted: accepted, hidden_count: hidden };
}

/**
 * Calibration dataset for Stufe D: pairs every reviewed similar group
 * with its members + sub-signals + the user's kept/hidden decision. The
 * caller writes this to disk; offline tooling regresses the weights.
 *
 * "kept" = photo_curation.status is 'visible' or 'favorite' (or absent,
 * which defaults to visible). "hidden" = explicitly hidden by the user.
 * Photos that aren't curated for this user fall back to "kept".
 */
export interface CalibrationEntry {
  group_id: number;
  group_confidence: AiConfidence | null;
  group_ai_picked_photo_ids: number[];
  reviewed_at: string;
  photos: Array<{
    photo_id: number;
    user_kept: boolean;
    ai_picked: boolean;
    has_face: boolean;
    signals: Record<string, number>;
  }>;
}

export async function exportCalibrationDatasetLogic(
  userId: number,
): Promise<{ entries: CalibrationEntry[] }> {
  const groups = await dbAll<{
    id: number;
    reviewed_at: string;
    ai_picked_photo_ids: number[] | null;
    ai_picked_confidence: AiConfidence | null;
    ai_pick_details: AiPickDetails | null;
  }>(
    db.select({
      id: photoGroups.id,
      reviewed_at: photoGroups.reviewed_at as any,
      ai_picked_photo_ids: photoGroups.ai_picked_photo_ids,
      ai_picked_confidence: photoGroups.ai_picked_confidence as any,
      ai_pick_details: photoGroups.ai_pick_details,
    })
      .from(photoGroups)
      .where(and(eq(photoGroups.user_id, userId), isNotNull(photoGroups.reviewed_at))),
  );
  if (groups.length === 0) return { entries: [] };

  const groupIds = groups.map((g) => g.id);
  const members = await dbAll<{ group_id: number; photo_id: number }>(
    db.select({
      group_id: photoGroupMembers.group_id,
      photo_id: photoGroupMembers.photo_id,
    })
      .from(photoGroupMembers)
      .where(inArray(photoGroupMembers.group_id, groupIds)),
  );
  const membersByGroup = new Map<number, number[]>();
  for (const m of members) {
    const arr = membersByGroup.get(m.group_id);
    if (arr) arr.push(m.photo_id);
    else membersByGroup.set(m.group_id, [m.photo_id]);
  }
  const allPhotoIds = Array.from(new Set(members.map((m) => m.photo_id)));
  const curationRows = await dbAll<{ photo_id: number; status: string }>(
    db.select({ photo_id: photoCuration.photo_id, status: photoCuration.status })
      .from(photoCuration)
      .where(and(
        eq(photoCuration.user_id, userId),
        inArray(photoCuration.photo_id, allPhotoIds),
      )),
  );
  const hiddenSet = new Set(
    curationRows.filter((r) => r.status === "hidden").map((r) => r.photo_id),
  );

  const entries: CalibrationEntry[] = [];
  for (const g of groups) {
    const picked = new Set(g.ai_picked_photo_ids ?? []);
    const scoreRowByPhotoId = new Map(
      (g.ai_pick_details?.scores ?? []).map((s) => [s.photo_id, s] as const),
    );
    entries.push({
      group_id: g.id,
      group_confidence: g.ai_picked_confidence,
      group_ai_picked_photo_ids: g.ai_picked_photo_ids ?? [],
      reviewed_at: g.reviewed_at,
      photos: (membersByGroup.get(g.id) ?? []).map((pid) => {
        const score = scoreRowByPhotoId.get(pid);
        return {
          photo_id: pid,
          user_kept: !hiddenSet.has(pid),
          ai_picked: picked.has(pid),
          has_face: score?.has_face ?? false,
          signals: (score?.signals as Record<string, number>) ?? {},
        };
      }),
    });
  }
  return { entries };
}
