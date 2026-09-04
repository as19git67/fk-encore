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

import { and, eq, inArray, isNull, isNotNull, ne, or, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec, dbFirst } from "../db/adapter";
import {
  aiPickUserWeights,
  albumPhotos,
  albumShares,
  albums,
  faces,
  photoCuration,
  photoGroupMembers,
  photoGroups,
  photos,
  userFaceAssignments,
  type AiPickDetails,
} from "../db/schema";
import {
  PROMINENCE_FLOOR,
  PROMINENCE_SATURATION,
  KNOWN_BONUS,
  REDUNDANCY_SIMILARITY,
  classifyOrientation,
  computeFaceProminence,
  computeGroupPick,
  type AiConfidence,
  type Orientation,
  type PhotoSignals,
  type RedundantPair,
  type ScoringWeights,
} from "./group-auto-pick";
import { fetchWithTimeout } from "./rpc-timeout";
import { isHighConfidenceDuplicateGroup, recommendDuplicatePhoto, selectDeletableDuplicateMembers } from "./duplicate-candidates";

const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL || "http://localhost:8001";

/**
 * Ask the embedding service which members of each group show the same shot
 * twice, so `computeGroupPick` can stop selecting both (see
 * REDUNDANCY_SIMILARITY). One batched call per recompute run.
 *
 * Degrades to "no pairs known" on any failure: the redundancy rule then
 * simply doesn't fire and the pick set is what it was before the rule
 * existed. A scoring run must not fail because a diversity refinement was
 * unavailable — the picks are still perfectly usable without it.
 */
async function loadRedundantPairs(
  groups: Array<{ group_id: number; photo_ids: number[] }>,
): Promise<Map<number, RedundantPair[]>> {
  const byGroupId = new Map<number, RedundantPair[]>();
  const scannable = groups.filter((g) => g.photo_ids.length >= 2);
  if (scannable.length === 0) return byGroupId;

  try {
    const response = await fetchWithTimeout(`${EMBEDDING_SERVICE_URL}/redundant-pairs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groups: scannable.map((g) => ({
          group_id: g.group_id,
          photo_ids: g.photo_ids.map((id) => id.toString()),
        })),
        min_similarity: REDUNDANCY_SIMILARITY,
      }),
      queue: "embedding",
    });
    if (!response.ok) throw new Error(`Embedding service returned ${response.status}`);
    const data = await response.json() as {
      groups: Array<{
        group_id: number;
        pairs: Array<{ photo_id_a: string; photo_id_b: string; similarity: number }>;
      }>;
    };
    for (const group of data.groups) {
      byGroupId.set(
        group.group_id,
        group.pairs.map((p) => ({
          photo_id_a: parseInt(p.photo_id_a, 10),
          photo_id_b: parseInt(p.photo_id_b, 10),
          similarity: p.similarity,
        })),
      );
    }
  } catch (err: any) {
    console.warn("Redundancy pairs unavailable, scoring without the diversity rule:", err.message);
  }
  return byGroupId;
}

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

interface FaceProminenceRow {
  face_id: number;
  photo_id: number;
  bbox: string;
  has_known_person: boolean;
}

/**
 * Load per-face prominence data for a set of photos and a specific user.
 *
 * Returns per-photo aggregated prominence metrics: total face prominence
 * (regime blend input) and face coverage computed only over prominent
 * faces (excludes tiny background detections below PROMINENCE_FLOOR).
 *
 * The user_id is needed because the identity bonus depends on
 * user_face_assignments — a face assigned to a known person for this
 * user gets a prominence boost.
 */
async function loadFaceProminenceData(
  photoIds: number[],
  userId: number,
): Promise<Map<number, { face_prominence: number; face_coverage: number }>> {
  const result = new Map<number, { face_prominence: number; face_coverage: number }>();
  if (photoIds.length === 0) return result;

  const rows = await dbAll<FaceProminenceRow>(
    db.select({
      face_id: faces.id,
      photo_id: faces.photo_id,
      bbox: faces.bbox,
      has_known_person: sql<boolean>`COALESCE(${userFaceAssignments.person_id} IS NOT NULL, false)`,
    })
      .from(faces)
      .leftJoin(
        userFaceAssignments,
        and(
          eq(userFaceAssignments.face_id, faces.id),
          eq(userFaceAssignments.user_id, userId),
        ),
      )
      .where(inArray(faces.photo_id, photoIds)),
  );

  const byPhoto = new Map<number, FaceProminenceRow[]>();
  for (const row of rows) {
    const arr = byPhoto.get(row.photo_id);
    if (arr) arr.push(row);
    else byPhoto.set(row.photo_id, [row]);
  }

  for (const [photoId, faceRows] of byPhoto) {
    let totalProminence = 0;
    let prominentCoverage = 0;
    for (const row of faceRows) {
      let bboxArea = 0;
      try {
        const bbox = typeof row.bbox === "string" ? JSON.parse(row.bbox) : row.bbox;
        const w = parseFloat(bbox.width) || 0;
        const h = parseFloat(bbox.height) || 0;
        bboxArea = w * h;
      } catch {
        continue;
      }
      const prominence = computeFaceProminence(bboxArea, row.has_known_person);
      totalProminence += prominence;
      if (prominence > 0) {
        prominentCoverage += bboxArea;
      }
    }
    result.set(photoId, {
      face_prominence: totalProminence,
      face_coverage: prominentCoverage,
    });
  }

  return result;
}

/**
 * Translate one SQL row into the input shape consumed by computeGroupPick.
 *
 * The embedding service writes signals into `ai_quality_details` under
 * the keys defined in `embedding_service/app/api/endpoints.py` —
 * `sharpness`, `contrast`, `exposure`, `eyes_open` (no `_score`
 * suffix). The PhotoSignals interface keeps the historical `_score`
 * field names from the investigation report so the scoring formula
 * comments stay readable; this function bridges the two.
 *
 * Both naming variants are accepted so the code keeps working if the
 * embedding service ever standardises on the suffixed keys.
 */
function toPhotoSignals(row: PhotoSignalRow): PhotoSignals {
  const d = row.ai_quality_details ?? {};
  const orientation: Orientation | undefined =
    row.width != null && row.height != null
      ? classifyOrientation(row.width, row.height)
      : undefined;
  const pick = (...keys: string[]): number | null => {
    for (const k of keys) {
      const v = d[k];
      if (typeof v === "number") return v;
    }
    return null;
  };
  return {
    photo_id: row.photo_id,
    blur_score: pick("sharpness", "blur_score"),
    contrast_score: pick("contrast", "contrast_score"),
    exposure_score: pick("exposure", "exposure_score"),
    clip_aesthetics: pick("clip_aesthetics"),
    clip_composition: pick("clip_composition"),
    clip_technical: pick("clip_technical"),
    face_sharpness: pick("face_sharpness"),
    eyes_open_score: pick("eyes_open", "eyes_open_score"),
    face_composition: pick("face_composition"),
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
 * Score groups and persist the result on photo_groups.
 *
 * Default behaviour: only **unreviewed** groups are scored — once the
 * user has decided we keep the KI's hands off, which is also what the
 * gallery filter assumes.
 *
 * The calibration export needs the opposite: reviewed groups *also*
 * need scores so we can compare the KI's pick against the user's
 * decision. Pass `options.includeReviewed = true` to widen the set;
 * combined with `options.onlyMissing = true` the call becomes
 * resumable (it scores only groups whose `ai_pick_details` is still
 * NULL, so re-running after a 524 picks up where it stopped without
 * redoing already-scored groups).
 */
export async function recomputeAiPicksForGroups(
  userId: number | undefined,
  groupIds?: number[],
  options?: { includeReviewed?: boolean; onlyMissing?: boolean },
): Promise<RecomputeResult> {
  const baseConds = [];
  if (!options?.includeReviewed) baseConds.push(isNull(photoGroups.reviewed_at));
  if (options?.onlyMissing) baseConds.push(isNull(photoGroups.ai_pick_details));
  if (typeof userId === "number") {
    baseConds.push(eq(photoGroups.user_id, userId));
  }
  if (groupIds && groupIds.length > 0) {
    baseConds.push(inArray(photoGroups.id, groupIds));
  }
  const groups = await dbAll<{ id: number; user_id: number }>(
    db.select({ id: photoGroups.id, user_id: photoGroups.user_id })
      .from(photoGroups)
      .where(baseConds.length > 0 ? and(...baseConds) : undefined),
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

  // Per-user weights for the scoring formula (Stufe D — see
  // group-auto-pick.calibration.ts). One row per user, falling back to
  // the hardcoded defaults when no calibration has been run yet.
  // Pre-fetched in a single query so the inner loop stays O(groups).
  const distinctUserIds = Array.from(new Set(groups.map((g) => g.user_id)));
  const weightRows = await dbAll<{ user_id: number; weights: ScoringWeights }>(
    db.select({
      user_id: aiPickUserWeights.user_id,
      weights: aiPickUserWeights.weights,
    })
      .from(aiPickUserWeights)
      .where(inArray(aiPickUserWeights.user_id, distinctUserIds)),
  );
  const weightsByUserId = new Map<number, ScoringWeights>();
  for (const row of weightRows) weightsByUserId.set(row.user_id, row.weights);
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

  // One batched redundancy scan for the whole run, before the scoring loop —
  // per-group calls would multiply the round-trip count by the group count.
  const redundantPairsByGroupId = await loadRedundantPairs(
    groups
      .map((g) => ({ group_id: g.id, photo_ids: byGroup.get(g.id) ?? [] }))
      .filter((g) => g.photo_ids.length >= 2),
  );

  // Etappe 1: load per-face prominence data for each user. Prominence
  // depends on user_face_assignments (identity bonus for known persons),
  // so we compute one map per user.
  const prominenceByUser = new Map<number, Map<number, { face_prominence: number; face_coverage: number }>>();
  for (const userId of distinctUserIds) {
    const userPhotoIds = groups
      .filter((g) => g.user_id === userId)
      .flatMap((g) => byGroup.get(g.id) ?? []);
    const uniquePhotoIds = [...new Set(userPhotoIds)];
    prominenceByUser.set(userId, await loadFaceProminenceData(uniquePhotoIds, userId));
  }

  let scored = 0;
  let skipped = 0;
  const nowSql = sql`NOW()`;
  for (const { id: groupId, user_id: groupUserId } of groups) {
    const photoIds = byGroup.get(groupId) ?? [];
    if (photoIds.length < 2) {
      skipped++;
      continue;
    }
    const prominenceMap = prominenceByUser.get(groupUserId);
    const groupSignals = photoIds.map((pid) => {
      const base: PhotoSignals = signalByPhotoId.get(pid) ?? {
        photo_id: pid,
        face_count: 0,
        face_coverage: 0,
      };
      const prom = prominenceMap?.get(pid);
      if (prom) {
        return {
          ...base,
          face_prominence: prom.face_prominence,
          face_coverage: prom.face_coverage,
        };
      }
      return { ...base, face_prominence: 0 };
    });
    const weights = weightsByUserId.get(groupUserId);
    const result = computeGroupPick(
      groupSignals,
      weights,
      redundantPairsByGroupId.get(groupId) ?? [],
    );
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
  overridePickedPhotoIds?: number[],
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
  // Caller-supplied override: the "one-click pick" UI for small groups
  // (Stufe C) lets the user pick a photo other than the AI's
  // suggestion. We treat the override as the new "kept" set; all other
  // group members get hidden. Empty / unsupplied → fall back to the
  // AI's pick set (the original Stufe-A accept path).
  const pickedArray = overridePickedPhotoIds && overridePickedPhotoIds.length > 0
    ? overridePickedPhotoIds
    : group.ai_picked_photo_ids ?? [];
  const picked = new Set(pickedArray);
  if (picked.size === 0) return { success: false, hidden_count: 0 };

  const members = await dbAll<{ photo_id: number }>(
    db.select({ photo_id: photoGroupMembers.photo_id })
      .from(photoGroupMembers)
      .where(eq(photoGroupMembers.group_id, groupId)),
  );
  // When the override doesn't actually exist in this group (UI bug,
  // stale data), refuse rather than hide everything by accident.
  const memberSet = new Set(members.map((m) => m.photo_id));
  for (const pid of picked) {
    if (!memberSet.has(pid)) {
      return { success: false, hidden_count: 0 };
    }
  }
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
 * Chunk size for the bulk-accept SQL pipeline. Each round-trip processes
 * up to BULK_ACCEPT_CHUNK_SIZE high-confidence groups in a single CTE
 * statement; the loop stops once a chunk returns zero groups.
 *
 * 500 keeps the IN-list small enough for Postgres to plan efficiently
 * (typical group has ~5 members, so the inner photo_group_members join
 * touches ~2.5k rows per chunk) and bounds the response time per
 * round-trip to well under the Cloudflare 100 s gateway timeout, even
 * with the worst-case 2k+ groups the initial rollout produces.
 */
const BULK_ACCEPT_CHUNK_SIZE = 500;

/**
 * Bulk-accept every unreviewed high-confidence AI pick of the user. Used
 * by the "Alle hochkonfidenten KI-Picks bestätigen" button in
 * DataManagementView for the initial rollout against ~5k groups.
 *
 * Implemented as a chunked CTE pipeline so the whole rollout finishes in
 * a handful of round-trips: the sequential per-group variant did ~5
 * INSERTs per group via acceptAiPickLogic which, against 2k+ groups, hit
 * the Cloudflare 100 s edge timeout and returned 502 to the browser.
 *
 * Each chunk:
 *   1. picks up to BULK_ACCEPT_CHUNK_SIZE matching groups (high
 *      confidence, unreviewed, non-empty ai_picked_photo_ids),
 *   2. computes the non-picked members via a join with
 *      photo_group_members,
 *   3. upserts photo_curation = 'hidden' for them (favorite stays
 *      favorite — same guard as acceptAiPickLogic),
 *   4. marks the groups reviewed,
 *   5. returns counts.
 *
 * Loop terminates when a chunk reports zero accepted groups; hidden_count
 * matches the sequential semantics (counts every non-picked member, not
 * just the rows that actually transitioned to 'hidden').
 */
export async function bulkAcceptHighConfidencePicksLogic(
  userId: number,
): Promise<BulkAcceptResult> {
  let totalAccepted = 0;
  let totalHidden = 0;
  // Hard cap on iterations as a safety net: with chunk size 500 and the
  // largest plausible rollout (~50k groups), 200 iterations is ample
  // while still preventing a runaway loop if a future bug accidentally
  // re-selects the same groups.
  for (let i = 0; i < 200; i++) {
    const result = await db.execute(sql`
      WITH targets AS (
        SELECT pg.id AS group_id, pg.ai_picked_photo_ids
        FROM photo_groups pg
        WHERE pg.user_id = ${userId}
          AND pg.reviewed_at IS NULL
          AND pg.ai_picked_at IS NOT NULL
          AND pg.ai_picked_confidence = 'high'
          AND pg.ai_picked_photo_ids IS NOT NULL
          AND array_length(pg.ai_picked_photo_ids, 1) > 0
        LIMIT ${BULK_ACCEPT_CHUNK_SIZE}
      ),
      to_hide AS (
        SELECT pgm.photo_id
        FROM photo_group_members pgm
        JOIN targets t ON t.group_id = pgm.group_id
        WHERE NOT (pgm.photo_id = ANY(t.ai_picked_photo_ids))
      ),
      inserted AS (
        INSERT INTO photo_curation (user_id, photo_id, status, updated_at)
        SELECT ${userId}, photo_id, 'hidden', NOW()
        FROM to_hide
        ON CONFLICT (user_id, photo_id) DO UPDATE
          SET status = CASE
                WHEN photo_curation.status = 'favorite' THEN 'favorite'
                ELSE 'hidden'
              END,
              updated_at = EXCLUDED.updated_at
        RETURNING photo_id
      ),
      reviewed AS (
        UPDATE photo_groups
        SET reviewed_at = NOW()
        WHERE id IN (SELECT group_id FROM targets)
        RETURNING id
      )
      SELECT
        (SELECT COUNT(*) FROM reviewed)::int AS groups_accepted,
        (SELECT COUNT(*) FROM to_hide)::int AS hidden_count,
        (SELECT COUNT(*) FROM inserted)::int AS rows_written
    `);
    const row = result.rows[0] as {
      groups_accepted: number;
      hidden_count: number;
      rows_written: number;
    };
    if (!row || row.groups_accepted === 0) break;
    totalAccepted += row.groups_accepted;
    totalHidden += row.hidden_count;
  }
  return { groups_accepted: totalAccepted, hidden_count: totalHidden };
}

export interface PeerConsensusResult {
  success: boolean;
  // Photos the consensus rule decided to hide. These are the rows we
  // actually wrote into photo_curation (skipping the requester's own
  // favorites — see the ON CONFLICT guard below).
  hidden_count: number;
  // Photos where peers had explicit signal but the consensus was to
  // keep (i.e. at least one favorite vetoed the hide votes).
  kept_count: number;
  // Photos with no peer signal at all. Left untouched.
  no_signal_count: number;
}

/**
 * "Konsens übernehmen" — apply the majority of *peers'* curation
 * decisions to the requester's own photo_curation rows for one group.
 *
 * Consensus rule (deliberately conservative, see investigation in
 * docs/ai-auto-pick.md): hide a photo only if at least one peer hid it
 * AND no peer favorited it. A single favorite vote vetoes the hide. No
 * peer signal at all → leave the photo as-is.
 *
 * The privacy boundary is the same as the queue aggregate: a peer's
 * decision only counts when peer and requester currently share at least
 * one album containing the photo.
 *
 * Like acceptAiPickLogic, the user's own existing favorites are never
 * clobbered into hidden — the ON CONFLICT guard ensures that.
 */
export async function acceptPeerConsensusLogic(
  userId: number,
  groupId: number,
): Promise<PeerConsensusResult> {
  const group = await dbFirst<{ id: number; reviewed_at: string | null }>(
    db.select({ id: photoGroups.id, reviewed_at: photoGroups.reviewed_at })
      .from(photoGroups)
      .where(and(eq(photoGroups.id, groupId), eq(photoGroups.user_id, userId))),
  );
  if (!group) return { success: false, hidden_count: 0, kept_count: 0, no_signal_count: 0 };
  if (group.reviewed_at) {
    return { success: true, hidden_count: 0, kept_count: 0, no_signal_count: 0 };
  }

  const members = await dbAll<{ photo_id: number }>(
    db.select({ photo_id: photoGroupMembers.photo_id })
      .from(photoGroupMembers)
      .where(eq(photoGroupMembers.group_id, groupId)),
  );
  if (members.length === 0) {
    return { success: false, hidden_count: 0, kept_count: 0, no_signal_count: 0 };
  }
  const memberIds = members.map((m) => m.photo_id);

  // Same EXISTS-double structure as in listReviewQueueLogic — only peers
  // who currently share an album with the requester for this photo are
  // allowed to influence the consensus.
  const peerRows = await dbAll<{
    photo_id: number;
    hidden: number;
    favorite: number;
  }>(
    db.select({
      photo_id: photoCuration.photo_id,
      hidden: sql<number>`SUM(CASE WHEN ${photoCuration.status} = 'hidden' THEN 1 ELSE 0 END)::int`,
      favorite: sql<number>`SUM(CASE WHEN ${photoCuration.status} = 'favorite' THEN 1 ELSE 0 END)::int`,
    })
      .from(photoCuration)
      .where(and(
        ne(photoCuration.user_id, userId),
        inArray(photoCuration.photo_id, memberIds),
        sql`EXISTS (
          SELECT 1 FROM ${albumPhotos} ap
          WHERE ap.photo_id = ${photoCuration.photo_id}
            AND (
              EXISTS (SELECT 1 FROM ${albums} a WHERE a.id = ap.album_id AND a.user_id = ${userId})
              OR EXISTS (SELECT 1 FROM ${albumShares} s WHERE s.album_id = ap.album_id AND s.user_id = ${userId})
            )
            AND (
              EXISTS (SELECT 1 FROM ${albums} a WHERE a.id = ap.album_id AND a.user_id = ${photoCuration.user_id})
              OR EXISTS (SELECT 1 FROM ${albumShares} s WHERE s.album_id = ap.album_id AND s.user_id = ${photoCuration.user_id})
            )
        )`,
      ))
      .groupBy(photoCuration.photo_id),
  );
  const peerByPhoto = new Map<number, { hidden: number; favorite: number }>();
  for (const p of peerRows) peerByPhoto.set(p.photo_id, { hidden: p.hidden, favorite: p.favorite });

  const toHide: number[] = [];
  let keptWithSignal = 0;
  let noSignal = 0;
  for (const m of members) {
    const peer = peerByPhoto.get(m.photo_id);
    if (!peer || (peer.hidden === 0 && peer.favorite === 0)) {
      noSignal++;
      continue;
    }
    if (peer.hidden > 0 && peer.favorite === 0) {
      toHide.push(m.photo_id);
    } else {
      keptWithSignal++;
    }
  }

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

  // Mark the group reviewed regardless of how many photos got hidden —
  // the user's explicit "Konsens übernehmen" click is the review act,
  // even if every photo turned out to have no peer signal.
  await dbExec(
    db.update(photoGroups)
      .set({ reviewed_at: nowIso })
      .where(eq(photoGroups.id, groupId)),
  );

  return {
    success: true,
    hidden_count: toHide.length,
    kept_count: keptWithSignal,
    no_signal_count: noSignal,
  };
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

/**
 * Score every reviewed group that does not yet have ai_pick_details.
 *
 * Used by the calibration export: the regular recompute path skips
 * reviewed groups by design (the UI never shows AI picks for reviewed
 * groups), but the calibration dataset needs them so we can compare
 * "what would the KI have picked?" against "what did the user keep?".
 *
 * Idempotent + resumable: filters on `ai_pick_details IS NULL`, so
 * re-running after a 524 timeout only touches the groups still
 * missing — no double-work.
 */
export function scoreReviewedGroupsForCalibration(): Promise<RecomputeResult> {
  return recomputeAiPicksForGroups(undefined, undefined, {
    includeReviewed: true,
    onlyMissing: true,
  });
}

export async function exportCalibrationDatasetLogic(
  userId: number,
): Promise<{ entries: CalibrationEntry[] }> {
  // Make sure reviewed groups have a score before we dump them — the
  // export is meaningless otherwise (this is exactly what bit the very
  // first run after PR #404). The helper is a no-op on groups that
  // already have ai_pick_details, so subsequent exports are free.
  await scoreReviewedGroupsForCalibration();

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

// ========== Review-Queue (Track I — Stufe A: Bulk-Accept-Strip) ==========
//
// Backing endpoint for the "Rapid Review" view: a paginated, sorted
// stream of the user's unreviewed groups, enriched with everything the
// card UI needs (cover thumbnail filename, sibling thumbnails, AI-pick
// info, confidence). Confidence-sorted (high first) so the user can
// blast through the easy decisions with the global "alle bestätigen"
// button before tackling medium/low manually.

export interface ReviewQueuePhoto {
  id: number;
  filename: string;
  taken_at: string | null;
  curation: "visible" | "hidden" | "favorite";
  ai_picked: boolean;
  // AI quality score (0..1), or null when the `quality` scan hasn't run
  // for this photo yet. Surfaced so the review-queue cards can show the
  // % rating directly instead of only inside the compare modal.
  ai_quality_score: number | null;
  // Aggregated curation status from *other* users who share at least one
  // album containing this photo. Only explicit decisions are counted —
  // `visible` is the implicit default and produces no row, so we cannot
  // distinguish "actively kept" from "never reviewed". The two real
  // signals are: `hidden` (peer voted to hide) and `favorite` (peer
  // voted strongly to keep). Both 0 ⇒ no peer signal, render nothing.
  peer_curation: {
    hidden: number;
    favorite: number;
  };
  // Pixel dimensions, as written by the face scan. Null for a photo that
  // has not been scanned yet — which is why the client treats "unknown"
  // as its own orientation rather than guessing one.
  //
  // Surfaced so the compare view can tell a portrait shot of a motif from
  // a landscape one: those are not redundant with each other, and a keep
  // set that thins the group down to one photo must not throw away the
  // only frame in the other orientation.
  width: number | null;
  height: number | null;
}

export interface ReviewQueueGroup {
  id: number;
  cover_photo_id: number | null;
  member_count: number;
  ai_picked_photo_ids: number[];
  ai_picked_confidence: AiConfidence | null;
  // Δ between the top photo's score and the best non-pick. Surfaced
  // so the card UI can render a confidence-bar (Stufe D). 0..~0.6 in
  // practice; HIGH_CONFIDENCE_DELTA (0.10) is the auto-hide threshold.
  // `null` for groups that have never been scored.
  runner_up_delta: number | null;
  duplicate_candidate: boolean;
  duplicate_recommended_photo_id: number | null;
  duplicate_deletable_count: number;
  duplicate_deletable_bytes: number;
  photos: ReviewQueuePhoto[];
}

/**
 * User-level calibration metadata. Surfaced alongside the queue so
 * the Bulk-Accept disclaimer can show "stimmt zu X % mit deinen
 * letzten Reviews überein" without a second round-trip. `null` when
 * the user has never run /calibrate-ai-pick-weights — the UI then
 * shows the global defaults disclaimer instead.
 */
export interface ReviewQueueUserCalibration {
  fitted_at: string;
  top1_accuracy_face: number;
  top1_accuracy_non_face: number;
  pair_count_face: number;
  pair_count_non_face: number;
}

export interface ReviewQueueResponse {
  total: number;
  // Count of *unreviewed* groups with ai_picked_confidence = 'high',
  // independent of the active filter. Surfaced so the
  // "Alle Sicheren bestätigen" button can disable itself when there's
  // nothing left to bulk-accept, even while the user is paging through
  // the medium/low strata.
  high_confidence_total: number;
  offset: number;
  groups: ReviewQueueGroup[];
  user_calibration: ReviewQueueUserCalibration | null;
}

/**
 * Sort order for the review queue:
 *   1. ai_picked_confidence: high > medium > low > null
 *   2. larger groups first within the same confidence (more click
 *      savings per accept)
 *   3. oldest groups first for stable pagination
 *
 * `groupConfidenceFilter` lets the UI filter the stream to a single
 * confidence stratum. Useful for the "show me only high-confidence"
 * variant where the user wants to bulk-accept fast.
 */
export async function listReviewQueueLogic(
  userId: number,
  opts: {
    offset?: number;
    limit?: number;
    confidence?: AiConfidence;
  } = {},
): Promise<ReviewQueueResponse> {
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 100));
  const offset = Math.max(0, opts.offset ?? 0);

  const baseConds = [
    eq(photoGroups.user_id, userId),
    isNull(photoGroups.reviewed_at),
  ];
  if (opts.confidence) {
    baseConds.push(eq(photoGroups.ai_picked_confidence, opts.confidence));
  }
  // A group is only worth reviewing while at least two of its members are still
  // visible (not hidden via curation). Once hiding or a hard-delete drops it
  // below that, there is nothing left to compare — keep it out of the queue
  // even if it was never explicitly marked reviewed (legacy / edge cases).
  const hasTwoVisibleMembers = sql`(
    SELECT COUNT(*) FROM ${photoGroupMembers} m
    LEFT JOIN ${photoCuration} c
      ON c.photo_id = m.photo_id AND c.user_id = ${userId}
    WHERE m.group_id = ${photoGroups.id}
      AND c.status IS DISTINCT FROM 'hidden'
  ) >= 2`;
  baseConds.push(hasTwoVisibleMembers);

  const totalRow = await dbFirst<{ c: number }>(
    db.select({ c: sql<number>`COUNT(*)::int` })
      .from(photoGroups)
      .where(and(...baseConds)),
  );
  const total = totalRow?.c ?? 0;

  // Filter-independent count of high-confidence unreviewed groups.
  // The button "Alle Sicheren bestätigen" works server-wide on the
  // user's high-confidence backlog, so its disable state has to reflect
  // that backlog — not the filtered window the user is currently
  // viewing.
  const highRow = await dbFirst<{ c: number }>(
    db.select({ c: sql<number>`COUNT(*)::int` })
      .from(photoGroups)
      .where(and(
        eq(photoGroups.user_id, userId),
        isNull(photoGroups.reviewed_at),
        eq(photoGroups.ai_picked_confidence, "high"),
        hasTwoVisibleMembers,
      )),
  );
  const highConfidenceTotal = highRow?.c ?? 0;

  // User-level calibration metadata. Loaded unconditionally (even when
  // total = 0) so the empty-state can still display "deine letzte
  // Kalibrierung war am …". Cheap — one row by PK.
  const calibRow = await dbFirst<{
    fitted_at: string;
    metadata: {
      top1_accuracy_face?: number;
      top1_accuracy_non_face?: number;
      pair_count_face?: number;
      pair_count_non_face?: number;
    } | null;
  }>(
    db.select({
      fitted_at: aiPickUserWeights.fitted_at,
      metadata: aiPickUserWeights.metadata,
    })
      .from(aiPickUserWeights)
      .where(eq(aiPickUserWeights.user_id, userId)),
  );
  const userCalibration: ReviewQueueUserCalibration | null = calibRow && calibRow.metadata
    ? {
        fitted_at: calibRow.fitted_at,
        top1_accuracy_face: calibRow.metadata.top1_accuracy_face ?? 0,
        top1_accuracy_non_face: calibRow.metadata.top1_accuracy_non_face ?? 0,
        pair_count_face: calibRow.metadata.pair_count_face ?? 0,
        pair_count_non_face: calibRow.metadata.pair_count_non_face ?? 0,
      }
    : null;

  if (total === 0) {
    return {
      total: 0,
      high_confidence_total: highConfidenceTotal,
      offset,
      groups: [],
      user_calibration: userCalibration,
    };
  }

  // Pull the requested window. Ordering follows the contract above.
  const confidenceRank = sql`
    CASE COALESCE(${photoGroups.ai_picked_confidence}, 'null')
      WHEN 'high'   THEN 1
      WHEN 'medium' THEN 2
      WHEN 'low'    THEN 3
      ELSE 4
    END
  `;
  const groupRows = await dbAll<{
    id: number;
    cover_photo_id: number | null;
    ai_picked_photo_ids: number[] | null;
    ai_picked_confidence: string | null;
    member_count: number;
    created_at: string | null;
    runner_up_delta: number | null;
  }>(
    db.select({
      id: photoGroups.id,
      cover_photo_id: photoGroups.cover_photo_id,
      ai_picked_photo_ids: photoGroups.ai_picked_photo_ids,
      ai_picked_confidence: photoGroups.ai_picked_confidence,
      member_count: sql<number>`(
        SELECT COUNT(*)::int FROM ${photoGroupMembers} m
        WHERE m.group_id = ${photoGroups.id}
      )`,
      created_at: photoGroups.created_at,
      // Pull the Δ out of the persisted score breakdown. Cast through
      // jsonb_typeof so a malformed row (or one fitted before #406's
      // schema lock) yields NULL instead of throwing.
      runner_up_delta: sql<number | null>`
        CASE
          WHEN ${photoGroups.ai_pick_details} IS NULL THEN NULL
          WHEN (${photoGroups.ai_pick_details}->>'runner_up_delta') IS NULL THEN NULL
          ELSE (${photoGroups.ai_pick_details}->>'runner_up_delta')::float
        END
      `,
    })
      .from(photoGroups)
      .where(and(...baseConds))
      .orderBy(
        confidenceRank,
        sql`(
          SELECT COUNT(*) FROM ${photoGroupMembers} m
          WHERE m.group_id = ${photoGroups.id}
        ) DESC`,
        photoGroups.created_at,
      )
      .limit(limit)
      .offset(offset),
  );
  if (groupRows.length === 0) {
    return {
      total,
      high_confidence_total: highConfidenceTotal,
      offset,
      groups: [],
      user_calibration: userCalibration,
    };
  }

  // Bulk-fetch member photo rows in a single query so the response is
  // O(1) round-trips regardless of how many groups the page contains.
  const groupIds = groupRows.map((g) => g.id);
  const memberRows = await dbAll<{
    group_id: number;
    photo_id: number;
    filename: string;
    taken_at: string | null;
    curation: string | null;
    ai_quality_score: number | null;
    similarity_score: number | null;
    width: number | null;
    height: number | null;
    created_at: string | null;
    latitude: number | null;
    longitude: number | null;
    description: string | null;
    keywords: string[];
    user_id: number;
    external_path: string | null;
    size: number;
  }>(
    db.select({
      group_id: photoGroupMembers.group_id,
      photo_id: photos.id,
      filename: photos.filename,
      taken_at: photos.taken_at,
      curation: photoCuration.status,
      ai_quality_score: photos.ai_quality_score,
      similarity_score: photoGroupMembers.similarity_score,
      width: photos.width,
      height: photos.height,
      created_at: photos.created_at,
      latitude: photos.latitude,
      longitude: photos.longitude,
      description: photos.description,
      keywords: photos.keywords,
      user_id: photos.user_id,
      external_path: photos.external_path,
      size: photos.size,
    })
      .from(photoGroupMembers)
      .innerJoin(photos, eq(photos.id, photoGroupMembers.photo_id))
      .leftJoin(
        photoCuration,
        and(
          eq(photoCuration.photo_id, photoGroupMembers.photo_id),
          eq(photoCuration.user_id, userId),
        ),
      )
      .where(inArray(photoGroupMembers.group_id, groupIds))
      .orderBy(photoGroupMembers.group_id, photos.taken_at, photos.id),
  );
  const membersByGroupId = new Map<number, typeof memberRows>();
  for (const m of memberRows) {
    const list = membersByGroupId.get(m.group_id);
    if (list) list.push(m);
    else membersByGroupId.set(m.group_id, [m]);
  }

  const photoIdsForPeers = memberRows.map((m) => m.photo_id);
  const albumRows = photoIdsForPeers.length === 0
    ? []
    : await dbAll<{ photo_id: number; album_id: number }>(
        db.select({ photo_id: albumPhotos.photo_id, album_id: albumPhotos.album_id })
          .from(albumPhotos)
          .where(inArray(albumPhotos.photo_id, photoIdsForPeers)),
      );
  const albumsByPhotoId = new Map<number, number[]>();
  for (const row of albumRows) {
    const ids = albumsByPhotoId.get(row.photo_id);
    if (ids) ids.push(row.album_id);
    else albumsByPhotoId.set(row.photo_id, [row.album_id]);
  }
  for (const ids of albumsByPhotoId.values()) ids.sort((a, b) => a - b);

  // Peer-curation aggregate. For every photo in the response, count
  // explicit curation rows from *other* users who currently share at
  // least one album with the requester that contains the photo. Photos
  // in private (un-shared) uploads naturally produce no peer signal,
  // since no peer can have curated them.
  //
  // The double-EXISTS structure enforces the privacy boundary on both
  // ends: the requester must reach the album (via owner or share) AND
  // the peer must also reach the album. Otherwise stale curation rows
  // from un-shared albums would leak into the aggregate.
  const peerByPhotoId = new Map<number, { hidden: number; favorite: number }>();
  if (photoIdsForPeers.length > 0) {
    const peerRows = await dbAll<{
      photo_id: number;
      hidden: number;
      favorite: number;
    }>(
      db.select({
        photo_id: photoCuration.photo_id,
        hidden: sql<number>`SUM(CASE WHEN ${photoCuration.status} = 'hidden' THEN 1 ELSE 0 END)::int`,
        favorite: sql<number>`SUM(CASE WHEN ${photoCuration.status} = 'favorite' THEN 1 ELSE 0 END)::int`,
      })
        .from(photoCuration)
        .where(and(
          ne(photoCuration.user_id, userId),
          inArray(photoCuration.photo_id, photoIdsForPeers),
          sql`EXISTS (
            SELECT 1 FROM ${albumPhotos} ap
            WHERE ap.photo_id = ${photoCuration.photo_id}
              AND (
                EXISTS (SELECT 1 FROM ${albums} a WHERE a.id = ap.album_id AND a.user_id = ${userId})
                OR EXISTS (SELECT 1 FROM ${albumShares} s WHERE s.album_id = ap.album_id AND s.user_id = ${userId})
              )
              AND (
                EXISTS (SELECT 1 FROM ${albums} a WHERE a.id = ap.album_id AND a.user_id = ${photoCuration.user_id})
                OR EXISTS (SELECT 1 FROM ${albumShares} s WHERE s.album_id = ap.album_id AND s.user_id = ${photoCuration.user_id})
              )
          )`,
        ))
        .groupBy(photoCuration.photo_id),
    );
    for (const p of peerRows) {
      peerByPhotoId.set(p.photo_id, { hidden: p.hidden, favorite: p.favorite });
    }
  }

  const groups: ReviewQueueGroup[] = groupRows.map((g) => {
    const members = membersByGroupId.get(g.id) ?? [];
    const pickedSet = new Set(g.ai_picked_photo_ids ?? []);
    const duplicateCandidate = isHighConfidenceDuplicateGroup(members, albumsByPhotoId);
    const duplicateRecommendedPhotoId = duplicateCandidate
      ? recommendDuplicatePhoto(members)
      : null;
    const deletableDuplicates = duplicateCandidate && duplicateRecommendedPhotoId != null
      ? selectDeletableDuplicateMembers(members, duplicateRecommendedPhotoId, userId)
      : [];
    return {
      id: g.id,
      cover_photo_id: g.cover_photo_id,
      member_count: g.member_count,
      ai_picked_photo_ids: g.ai_picked_photo_ids ?? [],
      ai_picked_confidence:
        g.ai_picked_confidence === "high" ||
        g.ai_picked_confidence === "medium" ||
        g.ai_picked_confidence === "low"
          ? (g.ai_picked_confidence as AiConfidence)
          : null,
      runner_up_delta: g.runner_up_delta,
      duplicate_candidate: duplicateCandidate,
      duplicate_recommended_photo_id: duplicateRecommendedPhotoId,
      duplicate_deletable_count: deletableDuplicates.length,
      duplicate_deletable_bytes: deletableDuplicates.reduce((sum, member) => sum + member.size, 0),
      photos: members.map((m) => ({
        id: m.photo_id,
        filename: m.filename,
        taken_at: m.taken_at,
        curation:
          m.curation === "hidden" || m.curation === "favorite"
            ? m.curation
            : "visible",
        ai_picked: pickedSet.has(m.photo_id),
        ai_quality_score: m.ai_quality_score ?? null,
        peer_curation: peerByPhotoId.get(m.photo_id) ?? { hidden: 0, favorite: 0 },
        width: m.width ?? null,
        height: m.height ?? null,
      })),
    };
  });

  return {
    total,
    high_confidence_total: highConfidenceTotal,
    offset,
    groups,
    user_calibration: userCalibration,
  };
}
