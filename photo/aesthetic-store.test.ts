import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { dbInsertReturning } from "../db/adapter";
import { photoAestheticRun, photos, users } from "../db/schema";
import {
  InvalidSettingsError,
  countBacklog,
  countScored,
  getAestheticSettings,
  markUnscorable,
  nextBatch,
  resetAestheticScores,
  runsToRecover,
  saveAestheticSettings,
  startRun,
  updateRun,
  finishRun,
  writeAestheticScore,
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
});
