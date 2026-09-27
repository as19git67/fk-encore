/**
 * Where a visited stop belongs (§6.4, §8.5): the block its arrival
 * falls in, in the order the day was lived.
 */
import { describe, expect, it } from "vitest";
import { localClock, placeVisitedStop, type PlaceableDay, type PlaceableStop } from "./visit-place";

function stop(osmRef: string, over: Partial<PlaceableStop> = {}): PlaceableStop {
  return { osmRef, status: "planned", ...over };
}

// 09:00–12:30 morning, 12:30–14:00 lunch, 14:00–18:00 afternoon.
function day(dayIndex: number, morning: PlaceableStop[], afternoon: PlaceableStop[]): PlaceableDay {
  return {
    dayIndex,
    detailed: true,
    blocks: [
      { id: "morning", kind: "spots", startMinutes: 540, budgetMinutes: 210, stops: morning },
      { id: "lunch", kind: "meal", startMinutes: 750, budgetMinutes: 90, stops: [] },
      { id: "afternoon", kind: "spots", startMinutes: 840, budgetMinutes: 240, stops: afternoon },
    ],
  };
}

const START = "2026-09-05";
// Two hours east of UTC, as in summer in central Europe.
const OFFSET = 120;

function at(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + ((h * 60 + m) - OFFSET) * 60_000).toISOString();
}

describe("the local clock", () => {
  it("reads the destination's date and time, not UTC's", () => {
    expect(localClock(new Date("2026-09-05T22:30:00Z"), 120)).toEqual({ date: "2026-09-06", minutes: 30 });
    expect(localClock(new Date("2026-09-05T08:15:00Z"), -300)).toEqual({ date: "2026-09-05", minutes: 195 });
  });
});

describe("placing a visited stop", () => {
  it("moves an afternoon stop seen in the morning into the morning", () => {
    const days = [day(0, [stop("a"), stop("b")], [stop("church")])];
    const placed = placeVisitedStop({
      days, startDate: START, osmRef: "church", arrivedAt: at(START, "10:30"), utcOffsetMinutes: OFFSET,
    });
    // Ahead of what is still open: it happened, they have not.
    expect(placed).toEqual({ dayIndex: 0, blockId: "morning", position: 0 });
  });

  it("follows what was ticked off before it, and precedes what came later", () => {
    const days = [day(0, [
      stop("early", { status: "done", doneAt: at(START, "09:30") }),
      stop("late", { status: "done", doneAt: at(START, "11:45") }),
      stop("open"),
    ], [stop("church")])];
    const placed = placeVisitedStop({
      days, startDate: START, osmRef: "church", arrivedAt: at(START, "10:30"), utcOffsetMinutes: OFFSET,
    });
    expect(placed).toEqual({ dayIndex: 0, blockId: "morning", position: 1 });
  });

  it("counts a tick without a time as earlier", () => {
    const days = [day(0, [stop("old", { status: "done" }), stop("open")], [stop("church")])];
    const placed = placeVisitedStop({
      days, startDate: START, osmRef: "church", arrivedAt: at(START, "10:30"), utcOffsetMinutes: OFFSET,
    });
    expect(placed?.position).toBe(1);
  });

  it("puts a lunch-time visit with the nearer spots block", () => {
    const days = [day(0, [stop("a")], [stop("church")])];
    // 12:50 is twenty minutes after the morning, seventy before the afternoon.
    expect(placeVisitedStop({
      days, startDate: START, osmRef: "church", arrivedAt: at(START, "12:50"), utcOffsetMinutes: OFFSET,
    })?.blockId).toBe("morning");
    // 13:40 is closer to the afternoon, where the church already is.
    expect(placeVisitedStop({
      days, startDate: START, osmRef: "church", arrivedAt: at(START, "13:40"), utcOffsetMinutes: OFFSET,
    })).toBeNull();
  });

  it("moves a stop planned for tomorrow into the day it was seen", () => {
    const days = [day(0, [stop("a")], []), day(1, [stop("tower")], [])];
    const placed = placeVisitedStop({
      days, startDate: START, osmRef: "tower", arrivedAt: at(START, "15:10"), utcOffsetMinutes: OFFSET,
    });
    expect(placed).toEqual({ dayIndex: 0, blockId: "afternoon", position: 0 });
  });

  it("leaves a stop that already stands where it happened", () => {
    const days = [day(0, [stop("church"), stop("b")], [])];
    expect(placeVisitedStop({
      days, startDate: START, osmRef: "church", arrivedAt: at(START, "10:30"), utcOffsetMinutes: OFFSET,
    })).toBeNull();
  });

  it("says nothing without dates, off the trip, or on a day not yet planned", () => {
    const days = [day(0, [stop("a")], [stop("church")])];
    const base = { days, osmRef: "church", arrivedAt: at(START, "10:30"), utcOffsetMinutes: OFFSET };
    expect(placeVisitedStop({ ...base, startDate: null })).toBeNull();
    expect(placeVisitedStop({ ...base, startDate: START, arrivedAt: at("2026-09-09", "10:30") })).toBeNull();
    const undetailed = [{ ...day(0, [], [stop("church")]), detailed: false }];
    expect(placeVisitedStop({ ...base, days: undetailed, startDate: START })).toBeNull();
  });

  it("never drops a stop into a split block or one without an hour", () => {
    const split: PlaceableDay = {
      dayIndex: 0,
      detailed: true,
      blocks: [
        { id: "morning", kind: "spots", startMinutes: 540, budgetMinutes: 210, stops: [], branches: [{}] },
        { id: "loose", kind: "spots", startMinutes: null, budgetMinutes: 210, stops: [] },
        { id: "afternoon", kind: "spots", startMinutes: 840, budgetMinutes: 240, stops: [stop("church")] },
      ],
    };
    expect(placeVisitedStop({
      days: [split], startDate: START, osmRef: "church", arrivedAt: at(START, "10:30"), utcOffsetMinutes: OFFSET,
    })).toBeNull();
  });
});
