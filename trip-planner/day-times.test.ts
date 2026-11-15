import { describe, expect, it } from "vitest";
import { withDayTimes } from "./day-times";
import { excursionTravel, excursionWays, withExcursions, type Excursion } from "./excursions";
import type { StoredDay } from "./plan-store";

const HOME = { lat: 43.0, lon: 11.0 };

function excursion(id: string, depart: number, back: number, lat = 43.4): Excursion {
  return { id, lat, lon: 11.0, label: id, radiusM: null, departMinutes: depart, returnMinutes: back };
}

function dayWith(excursions: Excursion[]): StoredDay {
  const blocks = withExcursions(
    [{ id: "day", label: "Tag", kind: "spots", startMinutes: 9 * 60, budgetMinutes: 600, stops: [] }],
    excursions,
    excursionWays(excursions, HOME, "car"),
  );
  return {
    id: 1, dayIndex: 0, detailed: true, fixpoints: [], anchor: null, excursions,
    blocks: blocks.map((b) => ({ ...b, stops: [] })),
  } as unknown as StoredDay;
}

function timed(day: StoredDay): StoredDay {
  return withDayTimes([day], { ideas: true, startDate: null, anchor: HOME, mode: "car" })[0];
}

describe("withDayTimes with an excursion", () => {
  it("counts the hours away as planned, the drive included, even with no spot there", () => {
    // 9:30 to 14:30 away from a day of ten hours (Anton, 15.11.: it read "21 min von 10 h").
    const drive = excursionTravel(HOME, { lat: 43.4, lon: 11.0 }, "car");
    const day = timed(dayWith([excursion("a", 9 * 60 + 30, 14 * 60 + 30)]));
    expect(day.plannedMinutes).toBe(5 * 60 + drive);
    expect(day.window).toEqual({ startMinutes: 9 * 60, endMinutes: 19 * 60 });
    expect(day.freeMinutes).toBe(600 - 5 * 60 - drive);
  });

  it("counts a chain once: the hop between the two, and only the last way back", () => {
    const first = excursion("a", 10 * 60, 12 * 60);
    const second = { ...excursion("b", 12 * 60, 15 * 60, 43.45), from: "a" };
    const day = timed(dayWith([first, second]));
    const home = excursionTravel(HOME, second, "car");
    // Away from 10:00 until back from the second one.
    expect(day.plannedMinutes).toBe(15 * 60 + home - 10 * 60);
  });

  it("leaves a day without an excursion as it was: nothing planned, all free", () => {
    const day = timed(dayWith([]));
    expect(day.plannedMinutes).toBe(0);
    expect(day.freeMinutes).toBe(600);
  });
});
