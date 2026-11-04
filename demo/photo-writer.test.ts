/**
 * The demo photos from Openverse, against the real database and import but
 * a fake Openverse and face detector: a candidate with a face is passed
 * over, each photo carries the shot's EXIF and not the original's, the
 * licence of each is recorded, the next run reuses the set, and a detector
 * that fails midway leaves the rest drawn.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import db from "../db/database";
import { demoPhoto, demoRun, photos, users } from "../db/schema";
import { registered } from "./registry";
import { removeRun } from "./remove";
import { drawPhoto, type PhotoDeps } from "./photo-sources";
import { writePhotos } from "./photo-writer";
import type { PhotoPlan, PlannedShot } from "./photos";

vi.mock("../photo/scan-worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../photo/scan-worker")>()),
  triggerWorkers: () => {},
}));
vi.setConfig({ testTimeout: 60_000 });

let ownerId: number;
const runs: number[] = [];

const shot = (index: number, over: Partial<PlannedShot>): PlannedShot => ({
  index,
  topic: "beach",
  takenAt: `2025-07-2${index} 1${index}:00:00`,
  camera: { make: "FUJIFILM", model: "X-T30" },
  gps: null,
  album: null,
  ...over,
});

const PLAN: PhotoPlan = {
  shots: [
    shot(0, { gps: { lat: 37.1176, lon: -8.5376 }, album: "summer" }),
    shot(1, { album: "summer" }),
    shot(2, { topic: "garden" }),
  ],
  albums: [{ key: "summer", name: "Sommerurlaub Testlauf" }],
};

interface Fake {
  deps: PhotoDeps;
  searches: string[];
}

/** Openverse with three beach photos (the detector sees a face in the first) and one garden photo; the detector fails when `brokenDetector`. */
function fakeServices(brokenDetector = false, faceInFirst = true): Fake {
  const searches: string[] = [];
  const results: Record<string, Array<{ id: string }>> = {
    beach: [{ id: "beach-0" }, { id: "beach-1" }, { id: "beach-2" }],
    garden: [{ id: "garden-1" }],
  };
  const deps: PhotoDeps = {
    openverseUrl: "https://openverse.test",
    insightfaceUrl: "http://faces.test",
    searchPauseMs: 0,
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.host === "openverse.test") {
        searches.push(url.searchParams.get("q") ?? "");
        const topic = url.searchParams.get("q")!.startsWith("beach") ? "beach" : url.searchParams.get("q")!.startsWith("garden") ? "garden" : "other";
        if (url.searchParams.get("page") !== "1") return Response.json({ results: [] });
        return Response.json({
          results: (results[topic] ?? []).map((r) => ({
            id: r.id,
            title: `Bild ${r.id}`,
            creator: "Beispiel",
            license: "cc0",
            license_version: "1.0",
            url: `https://img.test/${r.id}.jpg`,
            foreign_landing_url: `https://img.test/${r.id}`,
            width: 2000,
            height: 1500,
            tags: [],
          })),
        });
      }
      if (url.host === "img.test") {
        // The original carries its own camera; none of it may survive.
        const id = url.pathname.slice(1, -4);
        const jpeg = await sharp(await drawPhoto("landscape", id.length * 7 + id.charCodeAt(0)))
          .withMetadata({ exif: { IFD0: { Make: "Original", Model: id } } })
          .toBuffer();
        return new Response(new Uint8Array(jpeg));
      }
      if (url.host === "faces.test") {
        if (brokenDetector) return new Response("", { status: 503 });
        return Response.json({ faces: [], width: 1000, height: 1000 });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch,
  };
  // Which download shows a face is decided by the order: the first beach candidate.
  let detections = 0;
  const inner = deps.fetch;
  deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "faces.test" && !brokenDetector && faceInFirst && detections++ === 0) {
      return Response.json({ faces: [{ bbox: [100, 100, 400, 400] }], width: 1000, height: 1000 });
    }
    return inner(input, init);
  }) as typeof fetch;
  return { deps, searches };
}

async function newRun(): Promise<number> {
  const [row] = await db
    .insert(demoRun)
    .values({ owner_user_id: ownerId, seed: 1, size: "full", text_source: "template", status: "running", stage: "photos" })
    .returning({ id: demoRun.id });
  runs.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const [u] = await db.insert(users).values({ email: "demo-photos@beispiel.test", name: "Demo Fotos", password_hash: "x" }).returning({ id: users.id });
  ownerId = u.id;
});

afterAll(async () => {
  for (const id of runs) await removeRun(id);
  if (runs.length) await db.delete(demoRun).where(inArray(demoRun.id, runs));
  await db.delete(users).where(eq(users.id, ownerId));
});

describe("writePhotos from Openverse", () => {
  it("passes over a photo with a face, writes the shot's EXIF and records each licence", async () => {
    const runId = await newRun();
    const fake = fakeServices();
    const written = await writePhotos(runId, ownerId, 1, PLAN, "openverse", {}, fake.deps);
    expect(written).toMatchObject({ photos: 3, openverse: 3, drawn: 0, albums: 1, fallback: null });

    const chosen = await db.select().from(demoPhoto).where(eq(demoPhoto.run_id, runId)).orderBy(demoPhoto.position);
    expect(chosen.map((c) => c.openverse_id)).toEqual(["beach-1", "beach-2", "garden-1"]);
    expect(chosen.every((c) => c.source === "openverse" && c.license === "cc0" && c.landing_url?.startsWith("https://img.test/"))).toBe(true);

    const ids = await registered(runId, "photos");
    const rows = await db.select().from(photos).where(inArray(photos.id, ids));
    const first = rows.find((r) => r.id === chosen[0].photo_id)!;
    expect(first.taken_at?.slice(0, 19).replace("T", " ")).toBe("2025-07-20 10:00:00");
    expect(first.latitude).toBeCloseTo(37.1176, 3);
    expect(first.longitude).toBeCloseTo(-8.5376, 3);
    // Shots at home carry no position.
    expect(rows.find((r) => r.id === chosen[2].photo_id)!.latitude).toBeNull();
    expect(await registered(runId, "albums")).toHaveLength(1);
  });

  it("loads the previous run's set again before searching", async () => {
    await removeRun(runs[0]);
    const runId = await newRun();
    const fake = fakeServices(false, false);
    await writePhotos(runId, ownerId, 1, PLAN, "openverse", {}, fake.deps);
    const chosen = await db.select().from(demoPhoto).where(eq(demoPhoto.run_id, runId)).orderBy(demoPhoto.position);
    expect(chosen.map((c) => c.openverse_id)).toEqual(["beach-1", "beach-2", "garden-1"]);
    expect(fake.searches).toHaveLength(0);
  });

  it("draws the rest when the face detector fails, and says why", async () => {
    await removeRun(runs[1]);
    // A fresh set: no previous Openverse rows may be reused for this check.
    await db.delete(demoPhoto).where(inArray(demoPhoto.run_id, runs));
    const runId = await newRun();
    const fake = fakeServices(true);
    const written = await writePhotos(runId, ownerId, 1, PLAN, "openverse", {}, fake.deps);
    expect(written).toMatchObject({ photos: 3, openverse: 0, drawn: 3 });
    expect(written.fallback).toMatch(/503/);
    const chosen = await db.select().from(demoPhoto).where(eq(demoPhoto.run_id, runId));
    expect(chosen.every((c) => c.source === "drawn" && c.license === null)).toBe(true);
  });

  it("searches a topic's next query when one runs dry, and names why the rest was drawn", async () => {
    await removeRun(runs[2]);
    await db.delete(demoPhoto).where(inArray(demoPhoto.run_id, runs));
    const runId = await newRun();
    // Only the third beach query finds anything, two photos, the first with a face.
    const fake = fakeServices();
    const inner = fake.deps.fetch;
    fake.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.host === "openverse.test") {
        const q = url.searchParams.get("q");
        fake.searches.push(`${q}#${url.searchParams.get("page")}`);
        if (q !== "seaside" || url.searchParams.get("page") !== "1") return Response.json({ results: [] });
        const r = (id: string) => ({ id, title: id, creator: "Beispiel", license: "cc0", url: `https://img.test/${id}.jpg`, width: 2000, height: 1500, tags: [] });
        return Response.json({ results: [r("sea-0"), r("sea-1")] });
      }
      return inner(input, init);
    }) as typeof fetch;
    const plan: PhotoPlan = { shots: [shot(0, {}), shot(1, {})], albums: [] };
    const written = await writePhotos(runId, ownerId, 1, plan, "openverse", {}, fake.deps);
    expect(fake.searches.slice(0, 3)).toEqual(["beach#1", "sea coast#1", "seaside#1"]);
    expect(written).toMatchObject({ photos: 2, openverse: 1, drawn: 1 });
    expect(written.fallback).toBe("Treffer aller Themen aufgebraucht; 1 mit Gesicht verworfen");
  });
});
