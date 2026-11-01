/**
 * The photo plan of the demo household: the same seed gives the same
 * shots, every shot falls into the household's span, positions only on
 * the trips, and five albums at most.
 */
import { describe, expect, it } from "vitest";
import { planHousehold } from "./household";
import { PHOTO_TOPICS, planPhotos } from "./photos";

const full = planHousehold(20261026, "full", "2026-10-26");
const small = planHousehold(20261026, "small", "2026-10-26");

describe("planPhotos", () => {
  it("plans 500 shots for the full demo and 12 for the small one, the same for the same seed", () => {
    const a = planPhotos(7, "full", full);
    expect(a.shots).toHaveLength(500);
    expect(planPhotos(7, "small", small).shots).toHaveLength(12);
    expect(planPhotos(7, "full", full)).toEqual(a);
    expect(planPhotos(8, "full", full)).not.toEqual(a);
  });

  it("keeps every shot inside the span, in time order, with a camera's date format", () => {
    for (const [size, plan] of [["full", full], ["small", small]] as const) {
      const { shots } = planPhotos(7, size, plan);
      expect(shots.map((s) => s.index)).toEqual(shots.map((_, i) => i));
      for (const s of shots) {
        expect(s.takenAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        expect(s.takenAt.slice(0, 10) >= plan.from && s.takenAt.slice(0, 10) <= plan.to).toBe(true);
        expect(PHOTO_TOPICS).toContain(s.topic);
      }
      expect([...shots].sort((x, y) => x.takenAt.localeCompare(y.takenAt))).toEqual(shots);
    }
  });

  it("gives a position only to holiday shots, and none of the household's own address", () => {
    const { shots } = planPhotos(7, "full", full);
    const placed = shots.filter((s) => s.gps);
    expect(placed.length).toBeGreaterThan(50);
    expect(placed.every((s) => s.camera.make === "FUJIFILM")).toBe(true);
    expect(shots.filter((s) => s.topic === "garden").every((s) => s.gps === null)).toBe(true);
  });

  it("makes five albums: the latest holiday of each kind, the garden and Christmas", () => {
    const { shots, albums } = planPhotos(7, "full", full);
    expect(albums.map((a) => a.name).sort()).toEqual(
      ["Garten", "Sommerurlaub 2026", "Städtereise Kopenhagen 2026", "Weihnachten", "Winterurlaub 2026"].sort(),
    );
    for (const a of albums) expect(shots.some((s) => s.album === a.key)).toBe(true);
    // The summer holiday of 2024 is in the span but has no album.
    const summer2024 = shots.filter((s) => s.takenAt >= "2024-07-25" && s.takenAt < "2024-08-09" && s.gps);
    expect(summer2024.length).toBeGreaterThan(0);
    expect(summer2024.every((s) => s.album === null)).toBe(true);
  });
});
