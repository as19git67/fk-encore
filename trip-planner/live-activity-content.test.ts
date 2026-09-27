/**
 * The Lock Screen's day, as the server computes it (§8.5).
 *
 * The same cases as the app's TripDayActivityContentTests, on purpose:
 * the Activity must read the same whether the phone or the server wrote
 * its last update.
 */
import { describe, expect, it } from "vitest";
import {
  buildActivityContent,
  clock,
  displayName,
  staleDate,
  zonedClock,
  type ActivityBlock,
  type ActivityStop,
} from "./live-activity-content";

function stop(osmRef: string, name: string | null, dwell: number, travel = 0, category = "sight"): ActivityStop {
  return { osmRef, name, category, dwellMinutes: dwell, travelFromPrevious: { minutes: travel } };
}

function block(label: string, start: number | null, budget: number, stops: ActivityStop[] = [], carriedIn?: number): ActivityBlock {
  return {
    label, kind: "spots", budgetMinutes: budget, startMinutes: start, stops,
    usedMinutes: stops.reduce((sum, s) => sum + s.dwellMinutes + s.travelFromPrevious.minutes, 0),
    carriedInMinutes: carriedIn,
  };
}

// 09:00 "morning" with two stops, 14:00 "afternoon" with one.
const day = [
  block("morning", 540, 210, [stop("node:1", "Museum", 90), stop("node:2", "Aussichtspunkt", 60, 10)]),
  block("afternoon", 840, 210, [stop("node:3", "Café", 45)]),
];

describe("the Live Activity's content", () => {
  it("names the block, the stop the clock has them at, and the next", () => {
    expect(buildActivityContent(day, 570)).toEqual({
      blockLabel: "morning",
      blockKind: "spots",
      blockEndMinutes: 750,
      overrunMinutes: 0,
      currentStopName: "Museum",
      stopConfirmed: false,
      nextStopName: "Aussichtspunkt",
      lightHintText: null,
    });
  });

  it("moves on to the next stop as the block runs", () => {
    // 90 of 160 minutes of stops, spread over 160: the museum ends at 10:30.
    expect(buildActivityContent(day, 629)?.currentStopName).toBe("Museum");
    expect(buildActivityContent(day, 630)?.currentStopName).toBe("Aussichtspunkt");
    expect(buildActivityContent(day, 630)?.nextStopName).toBeNull();
  });

  it("changes block at the boundary", () => {
    expect(buildActivityContent(day, 749)?.blockLabel).toBe("morning");
    expect(buildActivityContent(day, 750)).toBeNull(); // the lunch gap: no block covers it
    expect(buildActivityContent(day, 840)?.blockLabel).toBe("afternoon");
  });

  it("carries the overrun from an earlier block", () => {
    const overrun = block("afternoon", 840, 60, [stop("node:3", "Café", 60)], 20);
    expect(buildActivityContent([overrun], 850)?.overrunMinutes).toBe(20);
  });

  it("says nothing before the first block, after the last, or without block times", () => {
    expect(buildActivityContent(day, 360)).toBeNull();
    expect(buildActivityContent(day, 1320)).toBeNull();
    expect(buildActivityContent([block("morning", null, 210, [stop("node:1", "Museum", 90)])], 540)).toBeNull();
  });

  it("gives a light hint only while it still lies ahead", () => {
    const light = [{ osmRef: "node:1", best: { kind: "golden", fromMinutes: 1150, toMinutes: 1180 } }];
    expect(buildActivityContent(day, 570, light)?.lightHintText).toBe("Goldene Stunde 19:10–19:40");
    const past = [{ osmRef: "node:1", best: { kind: "golden", fromMinutes: 500, toMinutes: 560 } }];
    expect(buildActivityContent(day, 570, past)?.lightHintText).toBeNull();
  });

  it("calls an unnamed place what it is, and a renamed one what the group calls it", () => {
    expect(displayName(stop("node:9", null, 10, 0, "viewpoint"))).toBe("Aussichtspunkt, ohne Namen");
    expect(displayName(stop("node:9", null, 10, 0, "unknown"))).toBe("Unbenannter Ort");
    expect(displayName({ ...stop("node:9", "Chiesa", 10), title: "Die Kirche am Hafen" })).toBe("Die Kirche am Hafen");
  });

  it("writes the clock the way the app does", () => {
    expect(clock(545)).toBe("09:05");
    expect(clock(1445)).toBe("00:05");
  });
});

describe("the local clock", () => {
  it("reads date, minutes and offset in the phone's time zone", () => {
    // 17:30 in Rome in September is 15:30 UTC.
    expect(zonedClock(new Date("2026-09-05T15:30:20Z"), "Europe/Rome"))
      .toEqual({ date: "2026-09-05", minutes: 1050, offsetMinutes: 120 });
    expect(zonedClock(new Date("2026-01-05T23:30:00Z"), "Europe/Rome"))
      .toEqual({ date: "2026-01-06", minutes: 30, offsetMinutes: 60 });
  });

  it("marks the content stale at the block's end, never within the minute", () => {
    const now = new Date("2026-09-05T08:10:42Z"); // 10:10 in Rome
    expect(staleDate(750, now, "Europe/Rome")?.toISOString()).toBe("2026-09-05T10:30:00.000Z");
    expect(staleDate(610, now, "Europe/Rome")?.getTime()).toBe(now.getTime() + 60_000);
    expect(staleDate(null, now, "Europe/Rome")).toBeNull();
  });
});
