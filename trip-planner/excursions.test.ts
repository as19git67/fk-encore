import { describe, expect, it } from "vitest";
import {
  blockStart, chainHours, linkSuggestions, chainOf, excursionPlaces, excursionProblem, withExcursions, withoutExcursion, type Excursion,
} from "./excursions";

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

describe("the way to an excursion", () => {
  it("is never reckoned on foot: a stay on foot goes by train or bus", async () => {
    const { excursionTravel } = await import("./excursions");
    const { travelLeg } = await import("./travel");
    const home = { lat: 43.0, lon: 11.0 };
    const there = { lat: 43.4, lon: 11.0 };
    const onFoot = excursionTravel(home, there, "foot");
    expect(onFoot).toBe(travelLeg(home, there, "transit").minutes);
    expect(onFoot).toBeLessThan(travelLeg(home, there, "foot").minutes / 3);
    expect(excursionTravel(home, there, "car")).toBe(travelLeg(home, there, "car").minutes);
  });
});

describe("a chain of excursions", () => {
  const linked = (e: Excursion, from: string): Excursion => ({ ...e, from });

  it("leaves each link when the one before starts on and drops the quarters between", () => {
    const list = chainHours([trip("a", "10:00", "12:00"), linked(trip("b", "11:00", "14:00"), "a")]);
    expect(list[1].departMinutes).toBe(12 * 60);
    const blocks = withExcursions(DAY, list, { there: (e) => (e.from ? 10 : 40), back: (e) => (e.id === "a" ? 0 : 40) });
    expect(blocks.map((b) => [b.id, b.startMinutes, b.budgetMinutes])).toEqual([
      ["day", 540, 60],
      ["excursion:a", 640, 80], // 10:40 to 12:00
      ["excursion:b", 730, 110], // 12:10 to 14:00, no way home between
      ["day@b", 880, 260], // back 14:40
    ]);
    expect(excursionProblem(list, () => 40)).toBeNull();
  });

  it("refuses a link to nothing, two links off one and a circle", () => {
    expect(excursionProblem([linked(trip("b", "11:00", "14:00"), "x")], () => 10)).toMatch(/davor gibt es/);
    expect(excursionProblem([
      trip("a", "10:00", "12:00"), linked(trip("b", "12:00", "14:00"), "a"), linked(trip("c", "12:00", "15:00"), "a"),
    ], () => 10)).toMatch(/nur zu einem nächsten/);
    expect(excursionProblem([linked(trip("a", "10:00", "12:00"), "b"), linked(trip("b", "12:00", "14:00"), "a")], () => 10))
      .toMatch(/Kreis/);
  });

  it("finds the whole chain from any link and closes it over a removed one", () => {
    const list = chainHours([
      trip("a", "09:00", "11:00"), linked(trip("b", "00:00", "13:00"), "a"), linked(trip("c", "00:00", "15:00"), "b"),
      trip("d", "16:00", "18:00"),
    ]);
    expect(chainOf(list, "c").map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(chainOf(list, "d").map((e) => e.id)).toEqual(["d"]);
    const without = withoutExcursion(list, "b");
    expect(without.find((e) => e.id === "c")).toMatchObject({ from: "a", departMinutes: 11 * 60 });
    const headless = withoutExcursion(list, "a");
    expect(headless.find((e) => e.id === "b")).toMatchObject({ from: null, departMinutes: 9 * 60 });
  });
});

describe("suggesting to go straight on", () => {
  const home = { lat: 44.10, lon: 9.82 };
  const near = (id: string, lat: number, depart: string, back: string): Excursion => ({ ...trip(id, depart, back), lat, lon: 9.70 });

  it("suggests the link when the hop is much shorter than the way home and out again", () => {
    const list = [near("a", 44.14, "09:30", "12:00"), near("b", 44.11, "13:00", "14:30")];
    const s = linkSuggestions(list, home, "transit", () => false).get("b");
    expect(s?.from).toBe("a");
    expect(s!.viaQuartersMinutes - s!.hopMinutes).toBeGreaterThanOrEqual(15);
    // Not with a spot at the quarters in between, and not once linked.
    expect(linkSuggestions(list, home, "transit", () => true).size).toBe(0);
    expect(linkSuggestions([list[0], { ...list[1], from: "a" }], home, "transit", () => false).size).toBe(0);
  });

  it("suggests nothing when the next destination lies on the other side of the quarters", () => {
    const list = [near("a", 44.14, "09:30", "12:00"), { ...near("b", 44.10, "13:00", "14:30"), lon: 9.95 }];
    expect(linkSuggestions(list, home, "transit", () => false).size).toBe(0);
  });
});
