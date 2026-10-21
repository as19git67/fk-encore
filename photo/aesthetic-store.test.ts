import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { dbInsertReturning } from "../db/adapter";
import { photoAestheticRun, photos, users } from "../db/schema";
import {
  InvalidSettingsError,
  countBacklog,
  countProvisionalTargets,
  countScored,
  deleteRuns,
  getAestheticSettings,
  markUnscorable,
  nextBatch,
  provisionalBatch,
  resetAestheticScores,
  runsToRecover,
  saveAestheticSettings,
  startRun,
  updateRun,
  finishRun,
  getCompositeWeights,
  recomputeQAlignComposites,
  saveCompositeSetting,
  trainingSamples,
  writeAestheticScore,
  writeProvisionalScore,
} from "./aesthetic-store";

const MODEL = "qalign_v1";

let userId: number;
const made: number[] = [];

async function makePhoto(seed: {
  mime?: string;
  model?: string | null;
  takenAt?: string | null;
  details?: Record<string, number> | null;
  score?: number | null;
} = {}): Promise<number> {
  const row = await dbInsertReturning<{ id: number }>(
    db
      .insert(photos)
      .values({
        user_id: userId,
        filename: `a-${Math.random().toString(36).slice(2)}.jpg`,
        original_name: "a.jpg",
        mime_type: seed.mime ?? "image/jpeg",
        size: 1000,
        taken_at: seed.takenAt ?? null,
        aesthetic_model: seed.model ?? null,
        ai_quality_details: seed.details ?? null,
        ai_quality_score: seed.score ?? null,
      })
      .returning({ id: photos.id }),
  );
  made.push(row!.id);
  return row!.id;
}

async function photoRow(id: number) {
  const [row] = await db.select().from(photos).where(eq(photos.id, id));
  return row!;
}

beforeEach(async () => {
  // Other test files share the database: start from no aesthetic marks at all.
  await db.update(photos).set({ aesthetic_model: MODEL });
  if (made.length) await db.delete(photos).where(inArray(photos.id, made));
  made.length = 0;
  await db.delete(photoAestheticRun);
  const [u] = await db
    .insert(users)
    .values({ email: `aesthetic-${Math.random().toString(36).slice(2)}@beispiel.test`, name: "Test", password_hash: "x" })
    .returning({ id: users.id });
  userId = u!.id;
});

afterAll(async () => {
  // Leave the column as every other test file found it: unset.
  await db.update(photos).set({ aesthetic_model: null });
  if (made.length) await db.delete(photos).where(inArray(photos.id, made));
});

describe("the backlog", () => {
  it("holds unscored images, not videos, not scored or unreadable photos", async () => {
    const fresh = await makePhoto();
    await makePhoto({ mime: "video/mp4" });
    await makePhoto({ model: MODEL });
    await makePhoto({ model: `${MODEL}:failed` });
    const older = await makePhoto({ model: "qalign_v0" });
    expect(await countBacklog(MODEL)).toBe(2);
    expect((await nextBatch(MODEL, 10)).sort()).toEqual([fresh, older].sort());
  });

  it("comes newest first and leaves out what this run skipped", async () => {
    const old = await makePhoto({ takenAt: "2020-05-01 10:00:00" });
    const recent = await makePhoto({ takenAt: "2026-05-01 10:00:00" });
    const undated = await makePhoto();
    expect(await nextBatch(MODEL, 10)).toEqual([recent, old, undated]);
    expect(await nextBatch(MODEL, 1)).toEqual([recent]);
    expect(await nextBatch(MODEL, 10, [recent])).toEqual([old, undated]);
  });
});

describe("writing a score", () => {
  const parts = { clip_aesthetics: 0.1, clip_composition: 0.5, clip_technical: 0.4, sharpness: 0.8, contrast: 0.7, exposure: 0.9 };

  it("replaces clip_aesthetics, adds qalign_quality and rebuilds the composite", async () => {
    const id = await makePhoto({ details: parts, score: 0.5 });
    // Photos of other test files are in the same database; count the change.
    const before = await countScored(MODEL);
    await writeAestheticScore(id, MODEL, { aesthetics: 4.6, quality: 3 });
    const row = await photoRow(id);
    expect(row.aesthetic_model).toBe(MODEL);
    expect(row.ai_quality_details).toEqual({ ...parts, clip_aesthetics: 0.9, qalign_quality: 0.5 });
    expect(row.ai_quality_score).toBeCloseTo(0.3 * 0.9 + 0.1 + 0.04 + 0.2 + 0.07 + 0.045, 5);
    expect(await countScored(MODEL)).toBe(before + 1);
  });

  it("keeps the composite of a photo the quality job has not reached", async () => {
    const id = await makePhoto({ details: null, score: null });
    await writeAestheticScore(id, MODEL, { aesthetics: 3, quality: 3 });
    const row = await photoRow(id);
    expect(row.ai_quality_score).toBeNull();
    expect(row.ai_quality_details).toEqual({ clip_aesthetics: 0.5, qalign_quality: 0.5 });
  });

  it("marks an unreadable photo, and the backfill hands both kinds back", async () => {
    const a = await makePhoto();
    const b = await makePhoto();
    const other = await makePhoto({ model: "qalign_v0" });
    await markUnscorable(a, MODEL);
    await writeAestheticScore(b, MODEL, { aesthetics: 3, quality: 3 });
    expect((await photoRow(a)).aesthetic_model).toBe(`${MODEL}:failed`);
    expect(await resetAestheticScores(MODEL)).toBeGreaterThanOrEqual(2);
    expect((await photoRow(a)).aesthetic_model).toBeNull();
    expect((await photoRow(b)).aesthetic_model).toBeNull();
    expect((await photoRow(other)).aesthetic_model).toBe("qalign_v0");
  });
});

describe("the provisional head", () => {
  const HEAD = "vith_head_v1";
  const parts = { clip_aesthetics: 0.1, clip_composition: 0.5, clip_technical: 0.4, sharpness: 0.8, contrast: 0.7, exposure: 0.9 };

  it("learns from Q-Align scores only", async () => {
    const scored = await makePhoto({ model: MODEL, details: { ...parts, clip_aesthetics: 0.73 } });
    const head = await makePhoto({ model: HEAD, details: { ...parts, clip_aesthetics: 0.4 } });
    const samples = await trainingSamples(MODEL, 1_000_000);
    expect(samples).toContainEqual({ photo_id: String(scored), score: 0.73 });
    expect(samples.map((s) => s.photo_id)).not.toContain(String(head));
  });

  it("scores images Q-Align has not reached and that this head has not scored", async () => {
    const fresh = await makePhoto();
    const olderHead = await makePhoto({ model: "vith_head_v0" });
    await makePhoto({ model: HEAD });
    await makePhoto({ model: MODEL });
    await makePhoto({ model: `${MODEL}:failed` });
    await makePhoto({ mime: "video/mp4" });
    expect(await countProvisionalTargets(HEAD)).toBe(2);
    expect(await provisionalBatch(HEAD, 0, 10)).toEqual([fresh, olderHead].sort((a, b) => a - b));
    expect(await provisionalBatch(HEAD, Math.min(fresh, olderHead), 10)).toEqual([Math.max(fresh, olderHead)]);
  });

  it("writes the value and the composite, and never over a Q-Align score", async () => {
    const id = await makePhoto({ details: parts, score: 0.5 });
    await writeProvisionalScore(id, HEAD, 0.904);
    const row = await photoRow(id);
    expect(row.aesthetic_model).toBe(HEAD);
    expect(row.ai_quality_details).toEqual({ ...parts, clip_aesthetics: 0.9 });
    expect(row.ai_quality_score).toBeCloseTo(0.3 * 0.9 + 0.1 + 0.04 + 0.2 + 0.07 + 0.045, 5);

    const night = await makePhoto({ model: MODEL, details: { ...parts, clip_aesthetics: 0.6 }, score: 0.5 });
    await writeProvisionalScore(night, HEAD, 0.1);
    expect((await photoRow(night)).aesthetic_model).toBe(MODEL);
    expect((await photoRow(night)).ai_quality_details?.clip_aesthetics).toBe(0.6);
  });
});

describe("settings", () => {
  it("saves a window and refuses an unreadable or empty one", async () => {
    const saved = await saveAestheticSettings({ enabled: true, window_start: "22:30", window_end: "05:00" });
    expect(saved).toMatchObject({ enabled: true, window_start: "22:30", window_end: "05:00" });
    expect(await getAestheticSettings()).toMatchObject({ window_start: "22:30" });
    await expect(saveAestheticSettings({ enabled: true, window_start: "25:00", window_end: "05:00" })).rejects.toBeInstanceOf(InvalidSettingsError);
    await expect(saveAestheticSettings({ enabled: true, window_start: "03:00", window_end: "03:00" })).rejects.toBeInstanceOf(InvalidSettingsError);
    await saveAestheticSettings({ enabled: false, window_start: "01:00", window_end: "06:00" });
  });
});

describe("the overall score without CLIP", () => {
  const parts = {
    clip_aesthetics: 0.8,
    clip_composition: 0.1,
    clip_technical: 0.1,
    qalign_quality: 0.6,
    sharpness: 0.5,
    contrast: 0.7,
    exposure: 0.9,
  };
  const weights = { aesthetics: 0.5, quality: 0.25, blur: 0.25 };

  it("stores adopted weights, rebuilds Q-Align photos only, and goes back on reset", async () => {
    const scored = await makePhoto({ model: MODEL, details: parts, score: 0.1 });
    const { qalign_quality: _, ...clipOnly } = parts;
    const unscored = await makePhoto({ details: clipOnly, score: 0.1 });

    await saveCompositeSetting({ weights, groups: 40, hit_rate_before: 0.5, hit_rate_after: 0.7, adopted_at: "2026-10-21T20:00:00Z" });
    expect(await getCompositeWeights()).toEqual(weights);
    expect((await getAestheticSettings()).composite).toMatchObject({ groups: 40 });
    expect(await recomputeQAlignComposites(weights)).toBeGreaterThanOrEqual(1);
    expect((await photoRow(scored)).ai_quality_score).toBeCloseTo(0.5 * 0.8 + 0.25 * 0.6 + 0.25 * 0.5, 5);
    expect((await photoRow(unscored)).ai_quality_score).toBeCloseTo(0.1, 5);

    // A new Q-Align score is written with the adopted weights.
    await writeAestheticScore(scored, MODEL, { aesthetics: 5, quality: 5 });
    expect((await photoRow(scored)).ai_quality_score).toBeCloseTo(0.5 + 0.25 + 0.25 * 0.5, 5);

    await saveCompositeSetting(null);
    expect(await getCompositeWeights()).toBeNull();
    await recomputeQAlignComposites(null);
    expect((await photoRow(scored)).ai_quality_score).toBeCloseTo(0.3 + 0.02 + 0.01 + 0.125 + 0.07 + 0.045, 5);
  });
});

describe("runs", () => {
  it("owe recovery while running or without the GPU back", async () => {
    const running = await startRun("window", 10);
    const clean = await startRun("manual", 3);
    await finishRun(clean, { status: "done", scored: 3, gpu_returned: true });
    const stranded = await startRun("window", 5);
    await finishRun(stranded, { status: "failed", error: "x", gpu_returned: false });
    expect((await runsToRecover(null)).map((r) => r.id).sort()).toEqual([running, stranded].sort());
    expect((await runsToRecover(running)).map((r) => r.id)).toEqual([stranded]);
    await updateRun(stranded, { gpu_returned: true });
    expect((await runsToRecover(running)).map((r) => r.id)).toEqual([]);
  });

  it("are deleted only once they owe nothing", async () => {
    const running = await startRun("window", 10);
    const clean = await startRun("manual", 3);
    await finishRun(clean, { status: "done", scored: 3, gpu_returned: true });
    const other = await startRun("manual", 2);
    await finishRun(other, { status: "stopped", gpu_returned: true });
    const stranded = await startRun("window", 5);
    await finishRun(stranded, { status: "failed", error: "x", gpu_returned: false });

    expect(await deleteRuns([clean, running, stranded])).toBe(1);
    expect(await deleteRuns([])).toBe(0);
    expect(await deleteRuns()).toBe(1);
    const left = await db.select({ id: photoAestheticRun.id }).from(photoAestheticRun);
    expect(left.map((r) => r.id).sort()).toEqual([running, stranded].sort());
  });
});
