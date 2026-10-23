import { describe, it, expect } from "vitest";
import { evaluateFaceSignals, MIN_DECIDED_PAIRS, type GroupPhoto } from "./face-signals-report";

/** One prominent face (bbox area 0.05) with the given values. */
function photo(hidden: boolean, clip: number | null, eye: number | null, lift: number | null): GroupPhoto {
  return {
    hidden,
    clip,
    faces: [{ area: 0.05, known: false, values: { eye_aspect: eye, mouth_lift: lift } }],
  };
}

/** `n` groups of one kept and one hidden photo. */
function groups(n: number, make: (i: number) => GroupPhoto[]): GroupPhoto[][] {
  return Array.from({ length: n }, (_, i) => make(i));
}

describe("evaluateFaceSignals", () => {
  it("compares the eye ratio with CLIP on the same pairs", () => {
    // Landmarks always right, CLIP right in every other pair.
    const g = groups(40, (i) => [
      photo(false, i % 2 ? 0.6 : 0.4, 0.3, null),
      photo(true, 0.5, 0.1, null),
    ]);
    const { pairs, signals } = evaluateFaceSignals(g, true);
    expect(pairs).toBe(40);
    const eyes = signals.find((s) => s.key === "eye_aspect")!;
    expect(eyes.decided).toBe(40);
    expect(eyes.hits).toBe(40);
    expect(eyes.clip!.hits).toBe(20);
    expect(eyes.verdict).toBe("better");
  });

  it("weights faces by prominence instead of taking the minimum", () => {
    // Kept photo: big open-eyed subject plus a tiny background face with closed eyes.
    const kept: GroupPhoto = {
      hidden: false,
      clip: 0.5,
      faces: [
        { area: 0.08, known: true, values: { eye_aspect: 0.3 } },
        { area: 0.0006, known: false, values: { eye_aspect: 0.05 } },
      ],
    };
    const g = groups(MIN_DECIDED_PAIRS, () => [kept, photo(true, 0.5, 0.2, null)]);
    const eyes = evaluateFaceSignals(g, true).signals.find((s) => s.key === "eye_aspect")!;
    expect(eyes.hits).toBe(MIN_DECIDED_PAIRS);
  });

  it("judges the mouth against chance and ignores ties", () => {
    const g = groups(40, (i) => [
      photo(false, null, null, i < 30 ? 0.2 : 0.1),
      photo(true, null, null, i < 30 ? 0.05 : 0.105),
    ]);
    const lift = evaluateFaceSignals(g, true).signals.find((s) => s.key === "mouth_lift")!;
    // The last ten pairs differ by 0.005, below EPS.
    expect(lift.decided).toBe(30);
    expect(lift.hits).toBe(30);
    expect(lift.verdict).toBe("better");
  });

  it("gives no verdict on too few pairs or incomplete coverage", () => {
    const g = groups(5, () => [photo(false, 0.6, 0.3, 0.2), photo(true, 0.4, 0.1, 0.0)]);
    expect(evaluateFaceSignals(g, true).signals.every((s) => s.verdict === "too_few" || s.pairs === 0)).toBe(true);
    expect(evaluateFaceSignals(g, false).signals.every((s) => s.verdict === "no_coverage")).toBe(true);
  });

  it("builds every kept × hidden pair of a group", () => {
    const g = [[photo(false, 0.5, 0.3, null), photo(false, 0.5, 0.3, null), photo(true, 0.5, 0.1, null)]];
    expect(evaluateFaceSignals(g, true).pairs).toBe(2);
  });
});

describe("faceSignalsReport (database)", () => {
  it("reads the caller's reviewed groups and coverage", async () => {
    const { default: db } = await import("../db/database");
    const { dbInsertReturning } = await import("../db/adapter");
    const schema = await import("../db/schema");
    const { createUserLogic } = await import("../user/user.service");
    const { faceSignalsReport } = await import("./face-signals-report");

    const u = await createUserLogic({ email: `fsr-${Date.now()}@example.com`, name: "FSR", password: "pw" });
    const ids: number[] = [];
    for (const name of ["kept.jpg", "hidden.jpg"]) {
      const row = await dbInsertReturning<{ id: number }>(
        db.insert(schema.photos)
          .values({ user_id: u.id, filename: name, original_name: name, mime_type: "image/jpeg", size: 1, width: 1000, height: 1000, ai_quality_details: { eyes_open: 0.5 } })
          .returning({ id: schema.photos.id }),
      );
      ids.push(row!.id);
    }
    const group = await dbInsertReturning<{ id: number }>(
      db.insert(schema.photoGroups)
        .values({ user_id: u.id, reviewed_at: new Date().toISOString() } as typeof schema.photoGroups.$inferInsert)
        .returning({ id: schema.photoGroups.id }),
    );
    await db.insert(schema.photoGroupMembers).values(ids.map((photo_id) => ({ group_id: group!.id, photo_id })));
    await db.insert(schema.photoCuration).values({ user_id: u.id, photo_id: ids[1], status: "hidden" } as typeof schema.photoCuration.$inferInsert);
    const bbox = JSON.stringify({ x: 0.3, y: 0.3, width: 0.2, height: 0.25 });
    await db.insert(schema.faces).values([
      { photo_id: ids[0], bbox, embedding: "[]", landmarks: "{}", eye_aspect: 0.3, mouth_lift: 0.1 },
      { photo_id: ids[1], bbox, embedding: "[]", landmarks: "{}", eye_aspect: 0.1, mouth_lift: 0.0 },
    ]);

    const report = await faceSignalsReport(u.id);
    expect(report.coverage).toMatchObject({ faces: 2, with_landmarks: 2, large_enough: 2, with_eyes: 2, with_mouth: 2 });
    expect(report.reviewed_groups).toBe(1);
    expect(report.pairs).toBe(1);
    expect(report.blocked).toBeNull();
    const eyes = report.signals.find((s) => s.key === "eye_aspect")!;
    expect(eyes.hits).toBe(1);
    expect(eyes.verdict).toBe("too_few");

    // Another user's data stays out.
    const other = await createUserLogic({ email: `fsr-o-${Date.now()}@example.com`, name: "O", password: "pw" });
    const empty = await faceSignalsReport(other.id);
    expect(empty.coverage.faces).toBe(0);
    expect(empty.blocked).not.toBeNull();
  });
});
