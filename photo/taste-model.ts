/**
 * The user's personal taste in the auto-pick (documentation/plans/
 * foto-aesthetik.md, stage 7).
 *
 * Fitting the formula's weights to the user's reviews stops at what the
 * signals measure: sharpness, eyes, exposure, an aesthetic score. Whether
 * the user keeps the frame with the child looking up, the warmer light or
 * the tighter crop, none of them says. The CLIP vector the embedding service
 * keeps for every photo does, so the service fits a pairwise logistic
 * regression on [formula score, CLIP vector] over the user's reviewed
 * groups ("kept over hidden") and the app adds the vector part to the score
 * as a fourth building block:
 *
 *   score = formula + (weights · vector − offset) / base_weight
 *
 * Dividing by `base_weight` keeps the formula's scale, so the multi-pick
 * threshold and the confidence gate mean what they meant; `offset` centres
 * the bonus on the reviewed photos.
 *
 * Whether it helps is measured like the other replays: each group scored by
 * a model fitted without it (5 folds by group), and offered only with a gain
 * of 2 points and 2 groups over the formula alone. The model lives in
 * `ai_pick_taste_model`; without a row nothing changes.
 *
 * The services come in as `TasteDeps`, so the decisions are tested without
 * the embedding service.
 */

import { eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec, dbFirst } from "../db/adapter";
import { aiPickTasteModel, type AiPickTasteMetadata } from "../db/schema";
import { scorePhoto, type ScoringWeights } from "./group-auto-pick";
import {
  DEFAULT_WEIGHTS,
  MIN_REPLAY_EXTRA_HITS,
  MIN_REPLAY_GAIN,
  MIN_REPLAY_GROUPS,
  isDecided,
  loadTrainingData,
  loadUserWeights,
  type TrainingGroup,
} from "./group-auto-pick.calibration";

/** Photo ids per `/taste/score` request (the service takes up to 2000). */
export const TASTE_SCORE_BATCH = 2_000;

// ─── What the embedding service takes and gives ─────────────────────────────

export interface TasteGroupPhoto {
  photo_id: string;
  kept: boolean;
  /** The formula score with the user's weights, without any taste. */
  base: number;
}

export interface TasteGroupInput {
  group_id: number;
  photos: TasteGroupPhoto[];
}

export interface TasteReplayScore {
  photo_id: string;
  group_id: number;
  combined: number;
  taste: number;
}

export interface TasteReplayResult {
  version: string;
  groups: number;
  folds: number;
  scores: TasteReplayScore[];
  missing: string[];
}

export interface TasteFit {
  version: string;
  base_weight: number;
  weights: number[];
  offset: number;
  ridge_lambda: number;
  groups: number;
  pairs: number;
  train_pair_accuracy: number;
}

export interface TasteDeps {
  /** Out-of-fold scores; throws `NoTasteGroupsError` when no group has every vector. */
  replay(groups: TasteGroupInput[]): Promise<TasteReplayResult>;
  train(groups: TasteGroupInput[]): Promise<TasteFit>;
  /** `weights · vector` per photo with a vector. */
  score(weights: number[], photoIds: string[]): Promise<{ photo_id: string; value: number }[]>;
}

/** The embedding service found no decided group whose photos all have a CLIP vector. */
export class NoTasteGroupsError extends Error {}

// ─── The stored model ───────────────────────────────────────────────────────

export interface TasteModel {
  version: string;
  weights: number[];
  base_weight: number;
  offset: number;
  metadata: AiPickTasteMetadata;
  fitted_at: string;
}

/** What the page shows of an adopted model: no weights. */
export interface TasteSetting {
  version: string;
  groups: number;
  hit_rate_before: number;
  hit_rate_after: number;
  fitted_at: string;
}

export function settingOf(model: TasteModel | null): TasteSetting | null {
  if (!model) return null;
  return {
    version: model.version,
    groups: model.metadata.groups,
    hit_rate_before: model.metadata.hit_rate_before,
    hit_rate_after: model.metadata.hit_rate_after,
    fitted_at: model.fitted_at,
  };
}

export async function loadTasteModel(userId: number): Promise<TasteModel | null> {
  return (await loadTasteModels([userId])).get(userId) ?? null;
}

export async function loadTasteModels(userIds: number[]): Promise<Map<number, TasteModel>> {
  const out = new Map<number, TasteModel>();
  if (userIds.length === 0) return out;
  const rows = await dbAll<TasteModel & { user_id: number }>(
    db.select({
      user_id: aiPickTasteModel.user_id,
      version: aiPickTasteModel.version,
      weights: aiPickTasteModel.weights,
      base_weight: aiPickTasteModel.base_weight,
      offset: aiPickTasteModel.offset,
      metadata: aiPickTasteModel.metadata,
      fitted_at: aiPickTasteModel.fitted_at,
    })
      .from(aiPickTasteModel)
      .where(inArray(aiPickTasteModel.user_id, userIds)),
  );
  for (const { user_id, ...model } of rows) out.set(user_id, model);
  return out;
}

async function saveTasteModel(userId: number, fit: TasteFit, metadata: AiPickTasteMetadata): Promise<void> {
  const values = {
    version: fit.version,
    weights: fit.weights,
    base_weight: fit.base_weight,
    offset: fit.offset,
    metadata,
    fitted_at: new Date().toISOString(),
  };
  await dbExec(
    db.insert(aiPickTasteModel)
      .values({ user_id: userId, ...values })
      .onConflictDoUpdate({ target: aiPickTasteModel.user_id, set: values }),
  );
}

/** Back to the formula alone. */
export async function deleteTasteModel(userId: number): Promise<boolean> {
  const existing = await dbFirst<{ user_id: number }>(
    db.select({ user_id: aiPickTasteModel.user_id }).from(aiPickTasteModel).where(eq(aiPickTasteModel.user_id, userId)),
  );
  if (!existing) return false;
  await dbExec(db.delete(aiPickTasteModel).where(eq(aiPickTasteModel.user_id, userId)));
  return true;
}

/** The bonus a model adds, in score units: (weights · vector − offset) / base_weight. */
export function tasteBonus(model: Pick<TasteModel, "base_weight" | "offset">, value: number): number {
  return (value - model.offset) / model.base_weight;
}

/** Bonus per photo id; photos without a CLIP vector get none. */
export async function tasteBonuses(model: TasteModel, photoIds: number[], deps: TasteDeps): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const ids = [...new Set(photoIds)];
  for (let i = 0; i < ids.length; i += TASTE_SCORE_BATCH) {
    const batch = ids.slice(i, i + TASTE_SCORE_BATCH).map(String);
    for (const s of await deps.score(model.weights, batch)) out.set(Number(s.photo_id), tasteBonus(model, s.value));
  }
  return out;
}

// ─── Replay ─────────────────────────────────────────────────────────────────

export type TasteVariantKey = "formula" | "current" | "with_taste" | "taste_only";

export interface TasteVariant {
  key: TasteVariantKey;
  label: string;
  groups: number;
  hits: number;
  /** Share of groups whose top-ranked photo is one the user kept. */
  hit_rate: number;
}

export interface TasteReport {
  /** Groups in which the user kept a photo and hid another. */
  decided_groups: number;
  /** ...in which every photo has a CLIP vector. The replay runs on these. */
  vector_groups: number;
  variants: TasteVariant[];
  /** Only "with_taste" can be adopted: taste alone would throw away the measured signals. */
  recommended: "with_taste" | null;
  /** Why nothing is recommended, in the user's words; null when something is. */
  reason: string | null;
  min_groups: number;
  /** The model in use now; null for the formula alone. */
  adopted: TasteSetting | null;
}

const LABELS: Record<TasteVariantKey, string> = {
  formula: "Nur die Formel",
  current: "Heute",
  with_taste: "Formel mit persönlichem Geschmack",
  taste_only: "Nur persönlicher Geschmack",
};

/** The groups as the embedding service takes them, with today's formula score per photo. */
export function tasteInput(groups: TrainingGroup[], weights: ScoringWeights): TasteGroupInput[] {
  return groups.filter(isDecided).map((g) => ({
    group_id: g.group_id,
    photos: g.photos.map((p) => ({
      photo_id: String(p.photo_id),
      kept: p.user_kept,
      base: scorePhoto({ ...p.signals, taste_bonus: null }, weights).score,
    })),
  }));
}

/** Top-1 agreement of `score`; ties go to the lower id, as in computeGroupPick. */
function hitsBy(groups: TrainingGroup[], score: (photoId: number) => number): { groups: number; hits: number } {
  let hits = 0;
  for (const group of groups) {
    let best: { score: number; id: number; kept: boolean } | null = null;
    for (const photo of group.photos) {
      const s = score(photo.photo_id);
      if (!best || s > best.score || (s === best.score && photo.photo_id < best.id)) {
        best = { score: s, id: photo.photo_id, kept: photo.user_kept };
      }
    }
    if (best?.kept) hits++;
  }
  return { groups: groups.length, hits };
}

function variant(key: TasteVariantKey, r: { groups: number; hits: number }): TasteVariant {
  return { key, label: LABELS[key], groups: r.groups, hits: r.hits, hit_rate: r.groups > 0 ? r.hits / r.groups : 0 };
}

/**
 * The report over loaded groups and the service's out-of-fold scores.
 * `currentBonus` is what the adopted model adds today (empty without one).
 */
export function tasteReportOn(
  all: TrainingGroup[],
  weights: ScoringWeights,
  replay: TasteReplayResult | null,
  currentBonus: Map<number, number>,
  adopted: TasteSetting | null,
): TasteReport {
  const decided = all.filter(isDecided);
  const combined = new Map<number, number>();
  const taste = new Map<number, number>();
  for (const s of replay?.scores ?? []) {
    combined.set(Number(s.photo_id), s.combined);
    taste.set(Number(s.photo_id), s.taste);
  }
  const scored = decided.filter((g) => g.photos.every((p) => combined.has(p.photo_id)));
  const formulaOf = new Map<number, number>();
  for (const g of scored) {
    for (const p of g.photos) formulaOf.set(p.photo_id, scorePhoto({ ...p.signals, taste_bonus: null }, weights).score);
  }

  const formula = variant("formula", hitsBy(scored, (id) => formulaOf.get(id)!));
  const withTaste = variant("with_taste", hitsBy(scored, (id) => combined.get(id)!));
  const variants = [formula];
  if (adopted) variants.push(variant("current", hitsBy(scored, (id) => formulaOf.get(id)! + (currentBonus.get(id) ?? 0))));
  variants.push(withTaste, variant("taste_only", hitsBy(scored, (id) => taste.get(id)!)));

  let recommended: TasteReport["recommended"] = null;
  let reason: string | null = null;
  if (scored.length < MIN_REPLAY_GROUPS) {
    reason =
      `Erst ${scored.length} entschiedene Gruppen haben für jedes Foto einen CLIP-Vektor; ` +
      `für eine belastbare Aussage braucht es ${MIN_REPLAY_GROUPS}.`;
  } else if (
    withTaste.hit_rate - formula.hit_rate >= MIN_REPLAY_GAIN &&
    withTaste.hits - formula.hits >= MIN_REPLAY_EXTRA_HITS
  ) {
    recommended = "with_taste";
  } else {
    reason = "Dein persönlicher Geschmack lässt den Auto-Pick deine Wahl nicht spürbar öfter treffen als die Formel allein.";
  }
  return {
    decided_groups: decided.length,
    vector_groups: scored.length,
    variants,
    recommended,
    reason,
    min_groups: MIN_REPLAY_GROUPS,
    adopted,
  };
}

interface Loaded {
  groups: TrainingGroup[];
  weights: ScoringWeights;
  model: TasteModel | null;
  input: TasteGroupInput[];
}

async function load(userId: number): Promise<Loaded> {
  const [groups, weights, model] = await Promise.all([
    loadTrainingData(userId),
    loadUserWeights(userId),
    loadTasteModel(userId),
  ]);
  const w = weights ?? DEFAULT_WEIGHTS;
  return { groups, weights: w, model, input: tasteInput(groups, w) };
}

async function reportFor(l: Loaded, deps: TasteDeps): Promise<TasteReport> {
  let replay: TasteReplayResult | null = null;
  if (l.input.length > 0) {
    try {
      replay = await deps.replay(l.input);
    } catch (err) {
      if (!(err instanceof NoTasteGroupsError)) throw err;
    }
  }
  const photoIds = l.groups.filter(isDecided).flatMap((g) => g.photos.map((p) => p.photo_id));
  const bonus = l.model ? await tasteBonuses(l.model, photoIds, deps) : new Map<number, number>();
  return tasteReportOn(l.groups, l.weights, replay, bonus, settingOf(l.model));
}

export async function replayTaste(userId: number, deps: TasteDeps): Promise<TasteReport> {
  return reportFor(await load(userId), deps);
}

/** Why adopting refused; the page shows the message. */
export class TasteNotAdoptedError extends Error {
  constructor(message: string, readonly report: TasteReport) {
    super(message);
  }
}

/**
 * Runs the replay again and, only if it recommends the taste, fits the model
 * on every usable group and stores it. The caller re-scores the open groups.
 */
export async function adoptTaste(userId: number, deps: TasteDeps): Promise<TasteReport> {
  const loaded = await load(userId);
  const report = await reportFor(loaded, deps);
  if (!report.recommended) {
    throw new TasteNotAdoptedError(report.reason ?? "Das Nachspielen empfiehlt den persönlichen Geschmack nicht", report);
  }
  const fit = await deps.train(loaded.input);
  if (!(fit.base_weight > 0)) {
    throw new TasteNotAdoptedError(
      "Das gelernte Modell verwirft die Formel ganz; so wird es nicht übernommen.",
      report,
    );
  }
  const before = report.variants.find((v) => v.key === "formula")!;
  const after = report.variants.find((v) => v.key === "with_taste")!;
  const metadata: AiPickTasteMetadata = {
    groups: fit.groups,
    pairs: fit.pairs,
    ridge_lambda: fit.ridge_lambda,
    train_pair_accuracy: fit.train_pair_accuracy,
    hit_rate_before: before.hit_rate,
    hit_rate_after: after.hit_rate,
  };
  await saveTasteModel(userId, fit, metadata);
  return { ...report, adopted: settingOf(await loadTasteModel(userId)) };
}
