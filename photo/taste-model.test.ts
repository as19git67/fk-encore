import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import db from "../db/database";
import { dbExec, dbInsertReturning } from "../db/adapter";
import { aiPickTasteModel, photoCuration, photoGroupMembers, photoGroups, photos, users } from "../db/schema";
import { DEFAULT_SCORING_WEIGHTS, computeGroupPick, scorePhoto, type PhotoSignals } from "./group-auto-pick";
import { MIN_REPLAY_GROUPS, type TrainingGroup } from "./group-auto-pick.calibration";
import {
  NoTasteGroupsError,
  TasteNotAdoptedError,
  adoptTaste,
  deleteTasteModel,
  loadTasteModel,
  replayTaste,
  tasteBonus,
  tasteBonuses,
  tasteInput,
  tasteReportOn,
  type TasteDeps,
  type TasteFit,
  type TasteReplayResult,
} from "./taste-model";

function signals(photoId: number, blur: number): PhotoSignals {
  return {
    photo_id: photoId,
    blur_score: blur,
    contrast_score: 0.5,
    exposure_score: 0.5,
    clip_aesthetics: 0.5,
    clip_composition: 0.5,
    clip_technical: 0.5,
    face_count: 0,
    face_coverage: 0,
    face_prominence: 0,
  };
}

/**
 * `n` groups of two: photo 2g+1 is sharper, photo 2g+2 is the one kept in
 * the first `keptSharp` groups' complement — the formula prefers sharpness,
 * the user does not always.
 */
function groups(n: number, keptSharp: number): TrainingGroup[] {
  const out: TrainingGroup[] = [];
  for (let g = 0; g < n; g++) {
    const sharp = 2 * g + 1;
    const soft = 2 * g + 2;
    const sharpKept = g < keptSharp;
    out.push({
      group_id: g + 1,
      photos: [
        { photo_id: sharp, user_kept: sharpKept, signals: signals(sharp, 0.9), has_face: false, qalign: false },
        { photo_id: soft, user_kept: !sharpKept, signals: signals(soft, 0.6), has_face: false, qalign: false },
      ],
    });
  }
  return out;
}

/** Out-of-fold scores that rank the kept photo first in `right` of the groups. */
function replayResult(all: TrainingGroup[], right: number): TasteReplayResult {
  const scores = all.flatMap((g, i) =>
    g.photos.map((p) => {
      const first = i < right ? p.user_kept : !p.user_kept;
      return { photo_id: String(p.photo_id), group_id: g.group_id, combined: first ? 1 : 0, taste: first ? 0.7 : 0.2 };
    }),
  );
  return { version: "clip_taste_v1", groups: all.length, folds: 5, scores, missing: [] };
}

describe("scorePhoto with a taste bonus", () => {
  it("adds the bonus and reports it", () => {
    const plain = scorePhoto(signals(1, 0.8));
    const tasted = scorePhoto({ ...signals(1, 0.8), taste_bonus: 0.05 });
    expect(tasted.score).toBeCloseTo(plain.score + 0.05, 10);
    expect(tasted.signals.taste).toBe(0.05);
    expect(plain.signals.taste).toBeUndefined();
  });

  it("still picks the best photo when the bonus pushes every score below zero", () => {
    const result = computeGroupPick([
      { ...signals(1, 0.8), taste_bonus: -2 },
      { ...signals(2, 0.8), taste_bonus: -3 },
    ]);
    expect(result.picked_photo_ids).toEqual([1]);
  });
});

describe("tasteBonus", () => {
  it("centres on the offset and keeps the formula's scale", () => {
    expect(tasteBonus({ base_weight: 4, offset: 1 }, 1)).toBe(0);
    expect(tasteBonus({ base_weight: 4, offset: 1 }, 1.4)).toBeCloseTo(0.1, 10);
  });

  it("asks the service in batches and maps the ids back", async () => {
    const calls: string[][] = [];
    const deps = {
      score: async (_w: number[], ids: string[]) => {
        calls.push(ids);
        return ids.map((id) => ({ photo_id: id, value: Number(id) }));
      },
    } as unknown as TasteDeps;
    const ids = Array.from({ length: 2500 }, (_, i) => i + 1);
    const bonus = await tasteBonuses(
      { version: "v", weights: [1], base_weight: 2, offset: 0, metadata: {} as never, fitted_at: "" },
      [...ids, 1],
      deps,
    );
    expect(calls.map((c) => c.length)).toEqual([2000, 500]);
    expect(bonus.get(10)).toBe(5);
  });
});

describe("tasteInput", () => {
  it("sends decided groups only, with the formula score without taste", () => {
    const all = groups(3, 3);
    all.push({
      group_id: 99,
      photos: [
        { photo_id: 90, user_kept: true, signals: signals(90, 0.5), has_face: false, qalign: false },
        { photo_id: 91, user_kept: true, signals: { ...signals(91, 0.5), taste_bonus: 9 }, has_face: false, qalign: false },
      ],
    });
    const input = tasteInput(all, DEFAULT_SCORING_WEIGHTS);
    expect(input.map((g) => g.group_id)).toEqual([1, 2, 3]);
    expect(input[0]!.photos[0]).toEqual({
      photo_id: "1",
      kept: true,
      base: scorePhoto(signals(1, 0.9)).score,
    });
  });
});

describe("tasteReportOn", () => {
  it("recommends the taste when it hits clearly more often than the formula", () => {
    const all = groups(40, 20); // the formula hits 20 of 40
    const report = tasteReportOn(all, DEFAULT_SCORING_WEIGHTS, replayResult(all, 30), new Map(), null);
    const by = Object.fromEntries(report.variants.map((v) => [v.key, v]));
    expect(report.variants.map((v) => v.key)).toEqual(["formula", "with_taste", "taste_only"]);
    expect(by.formula!.hits).toBe(20);
    expect(by.with_taste!.hits).toBe(30);
    expect(report.recommended).toBe("with_taste");
    expect(report.reason).toBeNull();
    expect(report.vector_groups).toBe(40);
  });

  it("keeps the formula when the gain is too small", () => {
    const all = groups(40, 20);
    const report = tasteReportOn(all, DEFAULT_SCORING_WEIGHTS, replayResult(all, 21), new Map(), null);
    expect(report.recommended).toBeNull();
    expect(report.reason).toMatch(/nicht spürbar öfter/);
  });

  it("recommends nothing below the minimum number of groups", () => {
    const all = groups(MIN_REPLAY_GROUPS - 1, 0);
    const report = tasteReportOn(all, DEFAULT_SCORING_WEIGHTS, replayResult(all, MIN_REPLAY_GROUPS - 1), new Map(), null);
    expect(report.recommended).toBeNull();
    expect(report.reason).toMatch(/braucht es 30/);
  });

  it("counts only groups the service scored", () => {
    const all = groups(40, 0);
    const result = replayResult(all, 40);
    result.scores = result.scores.filter((s) => s.group_id !== 1);
    const report = tasteReportOn(all, DEFAULT_SCORING_WEIGHTS, result, new Map(), null);
    expect(report.decided_groups).toBe(40);
    expect(report.vector_groups).toBe(39);
  });

  it("shows today's adopted model next to the formula", () => {
    const all = groups(40, 0); // the formula never hits
    const bonus = new Map<number, number>();
    for (const g of all) for (const p of g.photos) if (p.user_kept) bonus.set(p.photo_id, 1);
    const adopted = { version: "clip_taste_v1", groups: 40, hit_rate_before: 0, hit_rate_after: 1, fitted_at: "" };
    const report = tasteReportOn(all, DEFAULT_SCORING_WEIGHTS, replayResult(all, 40), bonus, adopted);
    const current = report.variants.find((v) => v.key === "current")!;
    expect(current.hits).toBe(40);
    expect(report.adopted).toEqual(adopted);
  });
});

// ─── Adopting and removing, against the database ──────────────────────────

async function seedUser(nGroups: number): Promise<number> {
  const user = await dbInsertReturning<{ id: number }>(
    db.insert(users).values({ email: "taste@test.com", name: "Test", password_hash: "x" }).returning({ id: users.id }),
  );
  const userId = user!.id;
  for (let g = 0; g < nGroups; g++) {
    const ids: number[] = [];
    for (const blur of [0.9, 0.6]) {
      const row = await dbInsertReturning<{ id: number }>(
        db.insert(photos).values({
          user_id: userId,
          filename: `t-${g}-${blur}.jpg`,
          original_name: "t.jpg",
          mime_type: "image/jpeg",
          size: 1,
          ai_quality_details: { sharpness: blur, contrast: 0.5, exposure: 0.5 },
        }).returning({ id: photos.id }),
      );
      ids.push(row!.id);
    }
    const group = await dbInsertReturning<{ id: number }>(
      db.insert(photoGroups).values({ user_id: userId, cover_photo_id: ids[0]!, reviewed_at: sql`NOW()` as never })
        .returning({ id: photoGroups.id }),
    );
    for (const [i, pid] of ids.entries()) {
      await dbExec(db.insert(photoGroupMembers).values({ group_id: group!.id, photo_id: pid, similarity_rank: i }));
    }
    // The user keeps the softer photo: the formula always misses.
    await dbExec(db.insert(photoCuration).values({ user_id: userId, photo_id: ids[0]!, status: "hidden" }));
  }
  return userId;
}

function fakeDeps(fit: Partial<TasteFit> = {}): TasteDeps & { trained: number } {
  const deps = {
    trained: 0,
    replay: async (input: Parameters<TasteDeps["replay"]>[0]): Promise<TasteReplayResult> => ({
      version: "clip_taste_v1",
      groups: input.length,
      folds: 5,
      scores: input.flatMap((g) =>
        g.photos.map((p) => ({ photo_id: p.photo_id, group_id: g.group_id, combined: p.kept ? 1 : 0, taste: p.kept ? 1 : 0 })),
      ),
      missing: [],
    }),
    train: async (input: Parameters<TasteDeps["train"]>[0]): Promise<TasteFit> => {
      deps.trained++;
      return {
        version: "clip_taste_v1",
        base_weight: 3,
        weights: [0.5, -0.25],
        offset: 0.1,
        ridge_lambda: 1,
        groups: input.length,
        pairs: input.length,
        train_pair_accuracy: 0.9,
        ...fit,
      };
    },
    score: async (_w: number[], ids: string[]) => ids.map((id) => ({ photo_id: id, value: 0.1 })),
  };
  return deps;
}

describe("adoptTaste / deleteTasteModel", () => {
  beforeEach(async () => {
    await db.delete(aiPickTasteModel);
    await db.delete(photoCuration);
    await db.delete(photoGroupMembers);
    await db.delete(photoGroups);
    await db.delete(photos);
    await db.delete(users);
  });

  it("stores the model with the replay numbers and removes it again", async () => {
    const userId = await seedUser(MIN_REPLAY_GROUPS);
    const deps = fakeDeps();
    const report = await adoptTaste(userId, deps);
    expect(deps.trained).toBe(1);
    expect(report.adopted?.groups).toBe(MIN_REPLAY_GROUPS);
    expect(report.adopted?.hit_rate_before).toBe(0);
    expect(report.adopted?.hit_rate_after).toBe(1);

    const model = await loadTasteModel(userId);
    expect(model?.weights).toEqual([0.5, -0.25]);
    expect(model?.base_weight).toBe(3);

    const again = await replayTaste(userId, deps);
    expect(again.variants.map((v) => v.key)).toContain("current");

    expect(await deleteTasteModel(userId)).toBe(true);
    expect(await loadTasteModel(userId)).toBeNull();
    expect(await deleteTasteModel(userId)).toBe(false);
  });

  it("refuses without a recommendation and stores nothing", async () => {
    const userId = await seedUser(MIN_REPLAY_GROUPS - 1);
    const deps = fakeDeps();
    await expect(adoptTaste(userId, deps)).rejects.toBeInstanceOf(TasteNotAdoptedError);
    expect(deps.trained).toBe(0);
    expect(await loadTasteModel(userId)).toBeNull();
  });

  it("refuses a model that throws the formula away", async () => {
    const userId = await seedUser(MIN_REPLAY_GROUPS);
    await expect(adoptTaste(userId, fakeDeps({ base_weight: -0.1 }))).rejects.toThrow(/verwirft die Formel/);
    const rows = await db.select().from(aiPickTasteModel).where(eq(aiPickTasteModel.user_id, userId));
    expect(rows).toHaveLength(0);
  });

  it("reports no usable group when the service has no vectors", async () => {
    const userId = await seedUser(3);
    const deps = fakeDeps();
    deps.replay = async () => {
      throw new NoTasteGroupsError("none");
    };
    const report = await replayTaste(userId, deps);
    expect(report.decided_groups).toBe(3);
    expect(report.vector_groups).toBe(0);
    expect(report.recommended).toBeNull();
  });
});
