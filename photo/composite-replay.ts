/**
 * Whether the overall score should drop the zero-shot CLIP prompts for
 * photos with a Q-Align value (documentation/plans/foto-aesthetik.md, "Where
 * the score is used"). Decided like the auto-pick replay: the reviewed groups
 * say which photos were kept, and a formula either ranks a kept one first or
 * it does not. Weights fitted here are judged on groups they were not fitted
 * on, and they are offered only when they beat today's formula by a margin.
 *
 * The overall score is one value per photo, so the replay pools the reviews
 * of every user.
 */

import { isNotNull } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { photoGroups, type CompositeSetting } from "../db/schema";
import {
  DEFAULT_COMPOSITE_WEIGHTS,
  compositeFromDetails,
  qalignCompositeParts,
  type CompositeWeights,
} from "./aesthetic-score";
import {
  MIN_PAIRS_FOR_FIT,
  MIN_REPLAY_EXTRA_HITS,
  MIN_REPLAY_GAIN,
  MIN_REPLAY_GROUPS,
  fitPairwiseWeights,
  isDecided,
  loadTrainingData,
  type TrainingGroup,
} from "./group-auto-pick.calibration";
import type { PhotoSignals } from "./group-auto-pick";
import {
  getAestheticSettings,
  saveCompositeSetting,
} from "./aesthetic-store";

const FOLDS = 5;

/** Spelled out: Encore's schema parser cannot read `Exclude<>`. */
export type CompositeRecommendation = "default" | "fitted";
export type CompositeVariantKey = "current" | CompositeRecommendation;

export interface CompositeVariant {
  key: CompositeVariantKey;
  label: string;
  groups: number;
  hits: number;
  /** Share of groups whose top-ranked photo is one the user kept. */
  hit_rate: number;
  /** The weights this variant scores with; null for the original formula. */
  weights: CompositeWeights | null;
}

export interface CompositeReport {
  /** Decided groups (a kept and a hidden photo) across all users. */
  decided_groups: number;
  /** ...in which every photo has a Q-Align value and a measured sharpness. The replay runs on these. */
  qalign_groups: number;
  variants: CompositeVariant[];
  recommended: CompositeRecommendation | null;
  /** Why nothing is recommended, in the user's words; null when something is. */
  reason: string | null;
  min_groups: number;
  /** What is in use now; null for the original formula. */
  adopted: CompositeSetting | null;
}

const LABELS: Record<CompositeVariantKey, string> = {
  current: "Heute",
  default: "Ohne CLIP, Startgewichte",
  fitted: "Ohne CLIP, neu gelernt",
};

/** The `ai_quality_details` keys the signals came from. */
export function detailsOf(s: PhotoSignals): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (key: string, v: number | null | undefined) => {
    if (typeof v === "number") out[key] = v;
  };
  put("sharpness", s.blur_score);
  put("contrast", s.contrast_score);
  put("exposure", s.exposure_score);
  put("clip_aesthetics", s.clip_aesthetics);
  put("clip_composition", s.clip_composition);
  put("clip_technical", s.clip_technical);
  put("qalign_quality", s.qalign_quality);
  put("face_sharpness", s.face_sharpness);
  put("eyes_open", s.eyes_open_score);
  put("face_composition", s.face_composition);
  return out;
}

/** A group the replay can judge: decided, and every photo scored by Q-Align with its sharpness measured. */
function replayable(group: TrainingGroup): boolean {
  return isDecided(group) && group.photos.every((p) => p.qalign && qalignCompositeParts(detailsOf(p.signals)) !== null);
}

/** Top-1 agreement of the overall score with `weights`. Ties go to the lower id, as in computeGroupPick. */
export function compositeHits(groups: TrainingGroup[], weights: CompositeWeights | null): { groups: number; hits: number } {
  let hits = 0;
  for (const group of groups) {
    let best: { score: number; id: number; kept: boolean } | null = null;
    for (const photo of group.photos) {
      const score = compositeFromDetails(detailsOf(photo.signals), weights) ?? -Infinity;
      if (!best || score > best.score || (score === best.score && photo.photo_id < best.id)) {
        best = { score, id: photo.photo_id, kept: photo.user_kept };
      }
    }
    if (best?.kept) hits++;
  }
  return { groups: groups.length, hits };
}

/** Weights from every kept-versus-hidden pair; too few pairs keep the starting point. */
export function fitCompositeWeights(groups: TrainingGroup[]): CompositeWeights {
  const pairs: number[][] = [];
  for (const group of groups) {
    for (const kept of group.photos) {
      if (!kept.user_kept) continue;
      const a = qalignCompositeParts(detailsOf(kept.signals));
      if (!a) continue;
      for (const hidden of group.photos) {
        if (hidden.user_kept) continue;
        const b = qalignCompositeParts(detailsOf(hidden.signals));
        if (b) pairs.push(a.map((v, k) => v - b[k]!));
      }
    }
  }
  if (pairs.length < MIN_PAIRS_FOR_FIT) return { ...DEFAULT_COMPOSITE_WEIGHTS };
  const d = DEFAULT_COMPOSITE_WEIGHTS;
  const [aesthetics, quality, blur] = fitPairwiseWeights(pairs, [d.aesthetics, d.quality, d.blur]).weights;
  return { aesthetics: aesthetics!, quality: quality!, blur: blur! };
}

/** Hits of weights fitted without the group they are judged on: k folds by group. */
export function crossValidatedCompositeHits(groups: TrainingGroup[], folds = FOLDS): { groups: number; hits: number } {
  const sorted = [...groups].sort((a, b) => a.group_id - b.group_id);
  const k = Math.min(folds, sorted.length);
  let hits = 0;
  for (let f = 0; f < k; f++) {
    const held = sorted.filter((_, i) => i % k === f);
    const train = sorted.filter((_, i) => i % k !== f);
    hits += compositeHits(held, fitCompositeWeights(train)).hits;
  }
  return { groups: sorted.length, hits };
}

function variant(key: CompositeVariantKey, r: { groups: number; hits: number }, weights: CompositeWeights | null): CompositeVariant {
  return { key, label: LABELS[key], groups: r.groups, hits: r.hits, hit_rate: r.groups > 0 ? r.hits / r.groups : 0, weights };
}

/** The replay over already loaded groups; `current` is what the overall score uses today. */
export function replayCompositeOnGroups(
  all: TrainingGroup[],
  current: CompositeWeights | null,
  adopted: CompositeSetting | null = null,
): CompositeReport {
  const decided = all.filter(isDecided);
  const scored = all.filter(replayable);
  const today = variant("current", compositeHits(scored, current), current);
  const variants = [
    today,
    variant("default", compositeHits(scored, DEFAULT_COMPOSITE_WEIGHTS), DEFAULT_COMPOSITE_WEIGHTS),
    variant("fitted", crossValidatedCompositeHits(scored), scored.length > 0 ? fitCompositeWeights(scored) : null),
  ];

  let recommended: CompositeRecommendation | null = null;
  let reason: string | null = null;
  if (scored.length < MIN_REPLAY_GROUPS) {
    reason =
      `Erst ${scored.length} entschiedene Gruppen haben durchgehend Q-Align-Werte; ` +
      `für eine belastbare Aussage braucht es ${MIN_REPLAY_GROUPS}.`;
  } else {
    const best = variants.filter((v) => v.key !== "current").sort((a, b) => b.hits - a.hits)[0]!;
    if (best.hit_rate - today.hit_rate >= MIN_REPLAY_GAIN && best.hits - today.hits >= MIN_REPLAY_EXTRA_HITS) {
      recommended = best.key as CompositeRecommendation;
    } else {
      reason = "Ohne die CLIP-Werte trifft die Gesamtnote eure Wahl nicht spürbar öfter als heute.";
    }
  }
  return {
    decided_groups: decided.length,
    qalign_groups: scored.length,
    variants,
    recommended,
    reason,
    min_groups: MIN_REPLAY_GROUPS,
    adopted,
  };
}

/** Every user's reviewed groups. */
async function loadAllGroups(): Promise<TrainingGroup[]> {
  const users = await dbAll<{ user_id: number }>(
    db.selectDistinct({ user_id: photoGroups.user_id }).from(photoGroups).where(isNotNull(photoGroups.reviewed_at)),
  );
  const out: TrainingGroup[] = [];
  for (const { user_id } of users) out.push(...(await loadTrainingData(user_id)));
  return out;
}

export async function replayComposite(): Promise<CompositeReport> {
  const [groups, settings] = await Promise.all([loadAllGroups(), getAestheticSettings()]);
  return replayCompositeOnGroups(groups, settings.composite?.weights ?? null, settings.composite);
}

/**
 * Runs the replay again and, only if it recommends a set, stores it. The
 * caller rebuilds the scores (`recomputeQAlignComposites`), which takes a
 * while on a large library.
 */
export async function adoptComposite(): Promise<{ report: CompositeReport; adopted: CompositeSetting | null }> {
  const report = await replayComposite();
  if (!report.recommended) return { report, adopted: null };
  const chosen = report.variants.find((v) => v.key === report.recommended)!;
  const before = report.variants.find((v) => v.key === "current")!;
  const setting: CompositeSetting = {
    weights: chosen.weights!,
    groups: report.qalign_groups,
    hit_rate_before: before.hit_rate,
    hit_rate_after: chosen.hit_rate,
    adopted_at: new Date().toISOString(),
  };
  await saveCompositeSetting(setting);
  return { report: { ...report, adopted: setting }, adopted: setting };
}
