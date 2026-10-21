/**
 * Per-user weight calibration for the AI auto-pick scoring formula.
 *
 * From the user's reviewed photo groups we build pairs (kept_photo,
 * hidden_photo) — every such pair tells us "the user prefers this
 * over that". We then fit a pairwise logistic regression on the
 * signal *differences* so that the model's score(kept) > score(hidden)
 * for as many pairs as possible.
 *
 * Math is intentionally light: vanilla gradient descent with positive
 * clipping + sum-to-1 normalisation after each step. No external ML
 * library, no Python service — keeps the dep surface trivial.
 *
 * Per-user weights live in `ai_pick_user_weights.weights` and are
 * loaded by the scoring service on every recompute (see
 * group-auto-pick.service.ts). Falls back to the hardcoded defaults
 * in scorePhoto() when the row is missing.
 */

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec, dbFirst } from "../db/adapter";
import {
  aiPickUserWeights,
  photoCuration,
  photoGroupMembers,
  photoGroups,
  photos,
  faces,
  userFaceAssignments,
  type AiPickWeights,
  type AiPickWeightsMetadata,
} from "../db/schema";
import {
  classifyOrientation,
  computeFaceProminence,
  scorePhoto,
  type PhotoSignals,
  type ScoringWeights,
} from "./group-auto-pick";
import { AESTHETIC_MODEL } from "./aesthetic-score";

// Canonical default weights — must match the formula in scorePhoto().
// Stored here so the regression can initialise from them and the
// scoring layer can use them as a fallback.
export const DEFAULT_WEIGHTS: AiPickWeights = {
  face: [0.40, 0.20, 0.15, 0.10, 0.05, 0.05, 0.05],
  non_face: [0.40, 0.25, 0.15, 0.10, 0.10],
};

// Signal labels for diagnostics + future UI display.
export const FACE_WEIGHT_LABELS = [
  "face_sharpness",
  "eyes_open",
  "face_coverage",
  "face_composition",
  "blur",
  "clip_aesthetics",
  "exposure_contrast",
] as const;
export const NON_FACE_WEIGHT_LABELS = [
  "blur",
  "clip_aesthetics",
  "clip_composition",
  "clip_technical",
  "exposure_contrast",
] as const;

function normaliseFaceCoverage(coverage: number): number {
  const SATURATION = 0.30;
  if (coverage <= 0) return 0;
  if (coverage >= SATURATION) return 1;
  return coverage / SATURATION;
}

function clamp01(v: number | null | undefined, fallback = 0.5): number {
  if (v == null || Number.isNaN(v)) return fallback;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Build the face-branch feature vector from a PhotoSignals row. */
export function faceFeatures(s: PhotoSignals): number[] {
  return [
    clamp01(s.face_sharpness),
    clamp01(s.eyes_open_score),
    normaliseFaceCoverage(s.face_coverage),
    clamp01(s.face_composition),
    clamp01(s.blur_score),
    clamp01(s.clip_aesthetics),
    0.5 * (clamp01(s.exposure_score) + clamp01(s.contrast_score)),
  ];
}

/**
 * Build the non-face-branch feature vector from a PhotoSignals row.
 * `technical` picks the signal of the technical slot the way scorePhoto()
 * does: Q-Align's quality where the photo has one, else the CLIP prompt.
 */
export function nonFaceFeatures(s: PhotoSignals, technical: "clip" | "qalign" = "clip"): number[] {
  const tech = technical === "qalign" && s.qalign_quality != null ? s.qalign_quality : s.clip_technical;
  return [
    clamp01(s.blur_score),
    clamp01(s.clip_aesthetics),
    clamp01(s.clip_composition),
    clamp01(tech),
    0.5 * (clamp01(s.exposure_score) + clamp01(s.contrast_score)),
  ];
}

/**
 * Pairwise logistic regression with positive-clip + sum-to-1
 * normalisation. Returns the fitted weight vector + the top-1 accuracy
 * achieved on the training pairs (= the fraction of pairs where
 * weights · diff > 0, i.e. the kept photo's score beat the hidden
 * one's).
 *
 * `pairs` are diff vectors: pair[i] = features(kept) - features(hidden).
 * Initial weights default to a uniform 1/n vector (gradient pushes the
 * useful signals up from there); pass `init` to seed from the defaults.
 */
export function fitPairwiseWeights(
  pairs: number[][],
  init: number[],
  opts?: { iters?: number; lr?: number },
): { weights: number[]; trainAcc: number; baselineAcc: number } {
  const n = init.length;
  const iters = opts?.iters ?? 600;
  const lr = opts?.lr ?? 0.10;

  if (pairs.length === 0) {
    return { weights: [...init], trainAcc: 0, baselineAcc: 0 };
  }
  // Validate dimensionality so a length mismatch surfaces as an error
  // rather than silently producing nonsense.
  for (const d of pairs) {
    if (d.length !== n) {
      throw new Error(
        `fitPairwiseWeights: pair vector length ${d.length} doesn't match init ${n}`,
      );
    }
  }
  const accuracy = (w: number[]) => {
    let ok = 0;
    for (const d of pairs) {
      let z = 0;
      for (let k = 0; k < n; k++) z += w[k] * d[k];
      if (z > 0) ok++;
    }
    return ok / pairs.length;
  };
  const baselineAcc = accuracy(init);

  const w = [...init];
  for (let iter = 0; iter < iters; iter++) {
    const grad = new Array(n).fill(0);
    for (const d of pairs) {
      let z = 0;
      for (let k = 0; k < n; k++) z += w[k] * d[k];
      const p = 1 / (1 + Math.exp(-z));
      const factor = 1 - p;
      for (let k = 0; k < n; k++) grad[k] += factor * d[k];
    }
    let sum = 0;
    for (let k = 0; k < n; k++) {
      w[k] = Math.max(0, w[k] + (lr * grad[k]) / pairs.length);
      sum += w[k];
    }
    if (sum > 0) for (let k = 0; k < n; k++) w[k] /= sum;
    else {
      // All weights collapsed to 0 — pathological, restore uniform.
      for (let k = 0; k < n; k++) w[k] = 1 / n;
    }
  }
  return { weights: w, trainAcc: accuracy(w), baselineAcc };
}

export interface TrainingPhoto {
  photo_id: number;
  user_kept: boolean;
  signals: PhotoSignals;
  has_face: boolean;
  /** The aesthetic score is the nightly Q-Align one, not the zero-shot or provisional one. */
  qalign: boolean;
}

export interface TrainingGroup {
  group_id: number;
  photos: TrainingPhoto[];
}

/**
 * Pull the user's reviewed groups + per-photo signals out of the
 * database. Photos hidden via `photo_curation` count as "not kept";
 * everything else (visible / favorite / no curation row) counts as
 * "kept" — same convention as the calibration export.
 */
async function loadTrainingData(userId: number): Promise<TrainingGroup[]> {
  const groups = await dbAll<{ id: number }>(
    db.select({ id: photoGroups.id })
      .from(photoGroups)
      .where(and(eq(photoGroups.user_id, userId), isNotNull(photoGroups.reviewed_at))),
  );
  if (groups.length === 0) return [];

  const groupIds = groups.map((g) => g.id);
  const members = await dbAll<{ group_id: number; photo_id: number }>(
    db.select({
      group_id: photoGroupMembers.group_id,
      photo_id: photoGroupMembers.photo_id,
    })
      .from(photoGroupMembers)
      .where(inArray(photoGroupMembers.group_id, groupIds)),
  );
  const byGroup = new Map<number, number[]>();
  for (const m of members) {
    const arr = byGroup.get(m.group_id);
    if (arr) arr.push(m.photo_id);
    else byGroup.set(m.group_id, [m.photo_id]);
  }
  const allPhotoIds = Array.from(new Set(members.map((m) => m.photo_id)));
  if (allPhotoIds.length === 0) return [];

  // Per-photo signals (same query shape as group-auto-pick.service).
  const signalRows = await dbAll<{
    photo_id: number;
    ai_quality_details: Record<string, number> | null;
    face_count: number;
    face_coverage: number;
    width: number | null;
    height: number | null;
    aesthetic_model: string | null;
  }>(
    db.select({
      photo_id: photos.id,
      ai_quality_details: photos.ai_quality_details,
      aesthetic_model: photos.aesthetic_model,
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
      .where(inArray(photos.id, allPhotoIds))
      .groupBy(photos.id),
  );
  const signalsByPhoto = new Map<number, PhotoSignals>();
  const qalignIds = new Set<number>();
  for (const row of signalRows) {
    if (row.aesthetic_model === AESTHETIC_MODEL) qalignIds.add(row.photo_id);
    const d = row.ai_quality_details ?? {};
    const pick = (...keys: string[]): number | null => {
      for (const k of keys) {
        const v = d[k];
        if (typeof v === "number") return v;
      }
      return null;
    };
    signalsByPhoto.set(row.photo_id, {
      photo_id: row.photo_id,
      blur_score: pick("sharpness", "blur_score"),
      contrast_score: pick("contrast", "contrast_score"),
      exposure_score: pick("exposure", "exposure_score"),
      clip_aesthetics: pick("clip_aesthetics"),
      clip_composition: pick("clip_composition"),
      clip_technical: pick("clip_technical"),
      qalign_quality: pick("qalign_quality"),
      face_sharpness: pick("face_sharpness"),
      eyes_open_score: pick("eyes_open", "eyes_open_score"),
      face_composition: pick("face_composition"),
      face_count: row.face_count,
      face_coverage: row.face_coverage,
      orientation: row.width != null && row.height != null
        ? classifyOrientation(row.width, row.height)
        : undefined,
    });
  }

  // Curation: any photo not 'hidden' counts as kept.
  const curationRows = await dbAll<{ photo_id: number; status: string }>(
    db.select({ photo_id: photoCuration.photo_id, status: photoCuration.status })
      .from(photoCuration)
      .where(and(
        eq(photoCuration.user_id, userId),
        inArray(photoCuration.photo_id, allPhotoIds),
      )),
  );
  const hiddenIds = new Set(
    curationRows.filter((r) => r.status === "hidden").map((r) => r.photo_id),
  );

  // Etappe 1: compute per-face prominence and merge into signals.
  const faceDetailRows = await dbAll<{
    face_id: number;
    photo_id: number;
    bbox: string;
    has_known_person: boolean;
  }>(
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
      .where(inArray(faces.photo_id, allPhotoIds)),
  );
  const facesByPhoto = new Map<number, typeof faceDetailRows>();
  for (const row of faceDetailRows) {
    const arr = facesByPhoto.get(row.photo_id);
    if (arr) arr.push(row);
    else facesByPhoto.set(row.photo_id, [row]);
  }
  for (const [photoId, faceRows] of facesByPhoto) {
    const sig = signalsByPhoto.get(photoId);
    if (!sig) continue;
    let totalProminence = 0;
    let prominentCoverage = 0;
    for (const row of faceRows) {
      let bboxArea = 0;
      try {
        const bbox = typeof row.bbox === "string" ? JSON.parse(row.bbox) : row.bbox;
        bboxArea = (parseFloat(bbox.width) || 0) * (parseFloat(bbox.height) || 0);
      } catch {
        continue;
      }
      const prom = computeFaceProminence(bboxArea, row.has_known_person);
      totalProminence += prom;
      if (prom > 0) prominentCoverage += bboxArea;
    }
    sig.face_prominence = totalProminence;
    sig.face_coverage = prominentCoverage;
  }
  for (const sig of signalsByPhoto.values()) {
    if (sig.face_prominence == null) sig.face_prominence = 0;
  }

  const out: TrainingGroup[] = [];
  for (const { id: groupId } of groups) {
    const photoIds = byGroup.get(groupId) ?? [];
    const trainPhotos: TrainingPhoto[] = [];
    for (const pid of photoIds) {
      const s = signalsByPhoto.get(pid);
      if (!s) continue;
      trainPhotos.push({
        photo_id: pid,
        user_kept: !hiddenIds.has(pid),
        signals: s,
        has_face: (s.face_prominence ?? 0) > 0,
        qalign: qalignIds.has(pid),
      });
    }
    if (trainPhotos.length >= 2) {
      out.push({ group_id: groupId, photos: trainPhotos });
    }
  }
  return out;
}

export interface CalibrationResult {
  /** Fitted weights, ready to persist on `ai_pick_user_weights`. */
  weights: AiPickWeights;
  /** Diagnostic counts + accuracy estimates. */
  metadata: AiPickWeightsMetadata;
}

/**
 * Run the full pipeline: load training data, build pairs, fit both
 * branches, return the result. Caller is responsible for persisting
 * the row.
 */
export async function calibrateUserWeights(userId: number): Promise<CalibrationResult> {
  const trainingGroups = await loadTrainingData(userId);

  const facePairs: number[][] = [];
  const nonFacePairs: number[][] = [];
  let mixedSkipped = 0;
  for (const group of trainingGroups) {
    for (const a of group.photos) {
      for (const b of group.photos) {
        if (a.photo_id === b.photo_id) continue;
        if (!a.user_kept || b.user_kept) continue; // we want kept > hidden
        if (a.has_face !== b.has_face) {
          mixedSkipped++;
          continue;
        }
        const fa = a.has_face ? faceFeatures(a.signals) : nonFaceFeatures(a.signals);
        const fb = a.has_face ? faceFeatures(b.signals) : nonFaceFeatures(b.signals);
        const diff = fa.map((v, k) => v - fb[k]);
        if (a.has_face) facePairs.push(diff);
        else nonFacePairs.push(diff);
      }
    }
  }

  const faceFit = fitPairwiseWeights(facePairs, [...DEFAULT_WEIGHTS.face]);
  const nonFaceFit = fitPairwiseWeights(nonFacePairs, [...DEFAULT_WEIGHTS.non_face]);

  return {
    weights: { face: faceFit.weights, non_face: nonFaceFit.weights },
    metadata: {
      pair_count_face: facePairs.length,
      pair_count_non_face: nonFacePairs.length,
      pair_count_skipped_mixed: mixedSkipped,
      top1_accuracy_face: faceFit.trainAcc,
      top1_accuracy_non_face: nonFaceFit.trainAcc,
      top1_accuracy_face_baseline: faceFit.baselineAcc,
      top1_accuracy_non_face_baseline: nonFaceFit.baselineAcc,
    },
  };
}

/**
 * Calibrate + persist for a single user. Returns the same shape as
 * `calibrateUserWeights` so the caller can surface the diagnostics in
 * the UI ("X% Übereinstimmung mit deinen Reviews" etc.).
 *
 * If neither branch found enough pairs to fit anything meaningful
 * (`pair_count_*` below `MIN_PAIRS`), the call is a no-op and the
 * existing row (if any) is preserved — better to fall back to the
 * defaults than to overfit on noise.
 */
export const MIN_PAIRS_FOR_FIT = 10;

export async function calibrateAndPersist(userId: number): Promise<CalibrationResult> {
  const result = await calibrateUserWeights(userId);
  const enoughFace = result.metadata.pair_count_face >= MIN_PAIRS_FOR_FIT;
  const enoughNonFace = result.metadata.pair_count_non_face >= MIN_PAIRS_FOR_FIT;
  if (!enoughFace && !enoughNonFace) {
    return result;
  }
  // For each branch with too little data, keep the defaults so a
  // half-trained user doesn't degrade their other branch.
  const persisted: AiPickWeights = {
    face: enoughFace ? result.weights.face : [...DEFAULT_WEIGHTS.face],
    non_face: enoughNonFace ? result.weights.non_face : [...DEFAULT_WEIGHTS.non_face],
  };

  await persistWeights(userId, persisted, result.metadata);
  return { ...result, weights: persisted };
}

async function persistWeights(
  userId: number,
  weights: AiPickWeights,
  metadata: AiPickWeightsMetadata,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO ai_pick_user_weights (user_id, weights, fitted_at, metadata)
    VALUES (
      ${userId},
      ${JSON.stringify(weights)}::jsonb,
      NOW(),
      ${JSON.stringify(metadata)}::jsonb
    )
    ON CONFLICT (user_id) DO UPDATE SET
      weights   = EXCLUDED.weights,
      fitted_at = EXCLUDED.fitted_at,
      metadata  = EXCLUDED.metadata
  `);
}

/**
 * Read the persisted weights for a user. Returns `null` when no row
 * exists; callers must fall back to DEFAULT_WEIGHTS.
 */
export async function loadUserWeights(userId: number): Promise<AiPickWeights | null> {
  const row = await dbFirst<{ weights: AiPickWeights }>(
    db.select({ weights: aiPickUserWeights.weights })
      .from(aiPickUserWeights)
      .where(eq(aiPickUserWeights.user_id, userId)),
  );
  return row?.weights ?? null;
}

// ─── Replay with the Q-Align signal (foto-aesthetik.md, stage 5) ─────────────
//
// The nightly run puts Q-Align's aesthetics under `clip_aesthetics` and adds
// `qalign_quality`. Whether the auto-pick should lean on them more is not a
// guess: the user's reviewed groups say which photo they kept, and a weight
// set either ranks that photo first or it does not. Weights fitted here are
// judged on groups they were not fitted on (k-fold by group), and they are
// offered only when they beat what the user has today by a margin.

/** Fewer decided groups than this, and a few lucky hits would decide. */
export const MIN_REPLAY_GROUPS = 30;
/** Gain in top-1 hit rate a new weight set needs over today's. */
export const MIN_REPLAY_GAIN = 0.02;
/** ...and in whole groups, so a small sample cannot pass on one hit. */
export const MIN_REPLAY_EXTRA_HITS = 2;
const REPLAY_FOLDS = 5;

export type ReplayVariantKey = "current" | "default" | "fitted" | "fitted_qalign";

export interface ReplayVariant {
  key: ReplayVariantKey;
  label: string;
  groups: number;
  hits: number;
  /** Share of groups whose top-ranked photo is one the user kept. */
  hit_rate: number;
}

export interface ReplayReport {
  /** Reviewed groups with at least two photos that still have signals. */
  reviewed_groups: number;
  /** ...in which the user kept at least one photo and hid at least one. */
  decided_groups: number;
  /** ...in which every photo has a nightly Q-Align score. The replay runs on these. */
  qalign_groups: number;
  variants: ReplayVariant[];
  recommended: Exclude<ReplayVariantKey, "current" | "default"> | null;
  /** Why nothing is recommended, in the user's words; null when something is. */
  reason: string | null;
  min_groups: number;
}

const VARIANT_LABELS: Record<ReplayVariantKey, string> = {
  current: "Heute",
  default: "Standardgewichte",
  fitted: "Neu gelernt",
  fitted_qalign: "Neu gelernt, Technik aus Q-Align",
};

/** Has a kept and a hidden photo: only such a group can be hit or missed. */
export function isDecided(group: TrainingGroup): boolean {
  return group.photos.some((p) => p.user_kept) && group.photos.some((p) => !p.user_kept);
}

/** Top-1 agreement: the photo `weights` rank first is one the user kept. Ties go to the lower id, as in computeGroupPick. */
export function topOneHits(groups: TrainingGroup[], weights: ScoringWeights): { groups: number; hits: number } {
  let hits = 0;
  for (const group of groups) {
    let best: { score: number; photo: TrainingPhoto } | null = null;
    for (const photo of group.photos) {
      const score = scorePhoto(photo.signals, weights).score;
      if (!best || score > best.score || (score === best.score && photo.photo_id < best.photo.photo_id)) {
        best = { score, photo };
      }
    }
    if (best?.photo.user_kept) hits++;
  }
  return { groups: groups.length, hits };
}

function pairDiffs(groups: TrainingGroup[], technical: "clip" | "qalign") {
  const face: number[][] = [];
  const nonFace: number[][] = [];
  let mixed = 0;
  for (const group of groups) {
    for (const a of group.photos) {
      if (!a.user_kept) continue;
      for (const b of group.photos) {
        if (b.user_kept) continue;
        if (a.has_face !== b.has_face) {
          mixed++;
          continue;
        }
        const fa = a.has_face ? faceFeatures(a.signals) : nonFaceFeatures(a.signals, technical);
        const fb = a.has_face ? faceFeatures(b.signals) : nonFaceFeatures(b.signals, technical);
        (a.has_face ? face : nonFace).push(fa.map((v, k) => v - fb[k]));
      }
    }
  }
  return { face, nonFace, mixed };
}

/** Fits both branches on `groups`; a branch with too few pairs keeps the defaults. */
export function fitWeights(
  groups: TrainingGroup[],
  technical: "clip" | "qalign",
): CalibrationResult {
  const pairs = pairDiffs(groups, technical);
  const faceFit = fitPairwiseWeights(pairs.face, [...DEFAULT_WEIGHTS.face]);
  const nonFaceFit = fitPairwiseWeights(pairs.nonFace, [...DEFAULT_WEIGHTS.non_face]);
  return {
    weights: {
      face: pairs.face.length >= MIN_PAIRS_FOR_FIT ? faceFit.weights : [...DEFAULT_WEIGHTS.face],
      non_face: pairs.nonFace.length >= MIN_PAIRS_FOR_FIT ? nonFaceFit.weights : [...DEFAULT_WEIGHTS.non_face],
      ...(technical === "qalign" ? { technical } : {}),
    },
    metadata: {
      pair_count_face: pairs.face.length,
      pair_count_non_face: pairs.nonFace.length,
      pair_count_skipped_mixed: pairs.mixed,
      top1_accuracy_face: faceFit.trainAcc,
      top1_accuracy_non_face: nonFaceFit.trainAcc,
      top1_accuracy_face_baseline: faceFit.baselineAcc,
      top1_accuracy_non_face_baseline: nonFaceFit.baselineAcc,
    },
  };
}

/** Hits of weights fitted without the group they are judged on: k folds by group. */
export function crossValidatedHits(
  groups: TrainingGroup[],
  technical: "clip" | "qalign",
  folds = REPLAY_FOLDS,
): { groups: number; hits: number } {
  const sorted = [...groups].sort((a, b) => a.group_id - b.group_id);
  const k = Math.min(folds, sorted.length);
  let hits = 0;
  for (let f = 0; f < k; f++) {
    const held = sorted.filter((_, i) => i % k === f);
    const train = sorted.filter((_, i) => i % k !== f);
    hits += topOneHits(held, fitWeights(train, technical).weights).hits;
  }
  return { groups: sorted.length, hits };
}

function variant(key: ReplayVariantKey, r: { groups: number; hits: number }): ReplayVariant {
  return { key, label: VARIANT_LABELS[key], groups: r.groups, hits: r.hits, hit_rate: r.groups > 0 ? r.hits / r.groups : 0 };
}

/** The replay over already loaded groups; `current` is what the user's picks use today. */
export function replayOnGroups(all: TrainingGroup[], current: ScoringWeights): ReplayReport {
  const decided = all.filter(isDecided);
  const scored = decided.filter((g) => g.photos.every((p) => p.qalign));
  const today = variant("current", topOneHits(scored, current));
  const variants = [
    today,
    variant("default", topOneHits(scored, DEFAULT_WEIGHTS)),
    variant("fitted", crossValidatedHits(scored, "clip")),
    variant("fitted_qalign", crossValidatedHits(scored, "qalign")),
  ];

  let recommended: ReplayReport["recommended"] = null;
  let reason: string | null = null;
  if (scored.length < MIN_REPLAY_GROUPS) {
    reason =
      `Erst ${scored.length} entschiedene Gruppen haben durchgehend Q-Align-Werte; ` +
      `für eine belastbare Aussage braucht es ${MIN_REPLAY_GROUPS}.`;
  } else {
    const best = variants
      .filter((v) => v.key === "fitted" || v.key === "fitted_qalign")
      .sort((a, b) => b.hits - a.hits)[0];
    if (best.hit_rate - today.hit_rate >= MIN_REPLAY_GAIN && best.hits - today.hits >= MIN_REPLAY_EXTRA_HITS) {
      recommended = best.key as ReplayReport["recommended"];
    } else {
      reason = "Neu gelernte Gewichte treffen deine Wahl nicht spürbar öfter als die heutigen.";
    }
  }
  return {
    reviewed_groups: all.length,
    decided_groups: decided.length,
    qalign_groups: scored.length,
    variants,
    recommended,
    reason,
    min_groups: MIN_REPLAY_GROUPS,
  };
}

export async function replayAutoPick(userId: number): Promise<ReplayReport> {
  const groups = await loadTrainingData(userId);
  return replayOnGroups(groups, (await loadUserWeights(userId)) ?? DEFAULT_WEIGHTS);
}

/**
 * Runs the replay again and, only if it recommends a weight set, fits that
 * set on all Q-Align groups and stores it as the user's weights.
 */
export async function adoptReplay(userId: number): Promise<{ report: ReplayReport; adopted: CalibrationResult | null }> {
  const groups = await loadTrainingData(userId);
  const report = replayOnGroups(groups, (await loadUserWeights(userId)) ?? DEFAULT_WEIGHTS);
  if (!report.recommended) return { report, adopted: null };

  const scored = groups.filter((g) => isDecided(g) && g.photos.every((p) => p.qalign));
  const fit = fitWeights(scored, report.recommended === "fitted_qalign" ? "qalign" : "clip");
  const before = report.variants.find((v) => v.key === "current")!;
  const after = report.variants.find((v) => v.key === report.recommended)!;
  const metadata: AiPickWeightsMetadata = {
    ...fit.metadata,
    replay: {
      variant: report.recommended,
      groups: report.qalign_groups,
      hit_rate_before: before.hit_rate,
      hit_rate_after: after.hit_rate,
    },
  };
  await persistWeights(userId, fit.weights, metadata);
  return { report, adopted: { weights: fit.weights, metadata } };
}
