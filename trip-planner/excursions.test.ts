import { describe, expect, it } from "vitest";
import { blockStart, excursionPlaces, excursionProblem, withExcursions, type Excursion } from "./excursions";

const DAY = [{ id: "day", label: "Tag", kind: "spots", startMinutes: 9 * 60, budgetMinutes: 600, stops: [] as string[] }];

function trip(id: string, depart: string, back: string): Excursion {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  return { id, lat: 1, lon: 1, label: id, radiusM: null, departMinutes: m(depart), returnMinutes: m(back) };
}

describe("withExcursions", () => {
  it("cuts the day around two excursions and plants their blocks in the gaps", () => {
    const blocks = withExcursions(DAY, [trip("b", "15:00", "18:00"), trip("a", "10:00", "13:00")], () => 40);
    expect(blocks.map((b) => [b.id, b.startMinutes, b.budgetMinutes])).toEqual([
      ["day", 540, 60], // 9:00 to 10:00 at the quarters
      ["excursion:a", 640, 140], // 10:40 to 13:00 there
      ["day@a", 820, 80], // back 13:40, out again 15:00
      ["excursion:b", 940, 140],
      ["day@b", 1120, 20], // back 18:40 until 19:00
    ]);
    expect(blocks[1].label).toBe("Ausflug nach a");
  });

  it("drops a piece at the quarters too short to hold anything", () => {
    const blocks = withExcursions(DAY, [trip("a", "09:10", "18:30")], () => 30);
    expect(blocks.map((b) => b.id)).toEqual(["excursion:a"]);
  });
});

describe("excursionProblem", () => {
  it("refuses two excursions at once and a window with no time there", () => {
    expect(excursionProblem([trip("a", "10:00", "13:00"), trip("b", "13:20", "16:00")], () => 40))
      .toMatch(/bevor ihr von a zurück seid/);
    expect(excursionProblem([trip("a", "10:00", "11:00")], () => 50)).toMatch(/keine Zeit/);
    expect(excursionProblem([trip("a", "10:00", "13:00"), trip("b", "14:00", "16:00")], () => 40)).toBeNull();
  });
});

describe("blockStart", () => {
  it("starts an excursion at its destination and the block after it at the quarters", () => {
    const places = excursionPlaces([{ id: "a", lat: 5, lon: 5 }]);
    const home = { lat: 0, lon: 0 };
    const there = { lat: 9, lon: 9 };
    expect(blockStart("excursion:a", "day", there, home, places)).toEqual({ lat: 5, lon: 5 });
    expect(blockStart("day@a", "excursion:a", there, home, places)).toBe(home);
    expect(blockStart("day", null, there, home, places)).toBe(there);
  });
});
