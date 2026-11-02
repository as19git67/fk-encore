/**
 * A booked visit: an appointment that names its spot (§4.4, §7.3).
 *
 * The ticket for the tower at 14:00 used to be a time beside the day
 * and the tower a candidate like any other — so the day showed the
 * time but not the tower, and the planner could put the tower into
 * Tuesday's morning as well. Tied to its spot, the appointment opens
 * the block after it, the tower is that block's pinned first stop, and
 * no solver sees it as a candidate on any day.
 */

import { describe, expect, it } from "vitest";
import type { PlannedBlockShape } from "./blocks";
import {
  budgetsForSolver,
  framedSpotsOf,
  hostOf,
  hostVisits,
  isVisit,
  placeFramed,
  reservedSpotRefs,
  withoutFramed,
} from "./frame-spots";
import { scheduleDay, type Fixpoint } from "./fixpoints";
import type { Candidate, PlannedBlock } from "./solver";

const QUARTERS = { lat: 48.37, lon: 10.9 };
const HOME = { start: QUARTERS, end: QUARTERS };

function north(metres: number) {
  return { lat: QUARTERS.lat + metres / 111_320, lon: QUARTERS.lon };
}

function candidate(ref: string, metres: number): Candidate {
  return { osmRef: ref, name: ref, ...north(metres), category: "attraction", dwellMinutes: 45, score: 3 };
}

function shape(id: string, budgetMinutes: number): PlannedBlockShape {
  return { id, label: id, kind: "spots", baseBudgetMinutes: budgetMinutes, budgetMinutes };
}

const DAY = [shape("morning", 210), shape("lunch", 90), shape("afternoon", 240)];

const TOWER: Fixpoint = {
  id: "t",
  label: "Turm",
  kind: "appointment",
  startMinutes: 14 * 60,
  durationMinutes: 90,
  travelMinutes: 15,
  spotRef: "way:7",
};

describe("telling a booked visit from the rest", () => {
  it("is an appointment with a spot and no block", () => {
    expect(isVisit(TOWER)).toBe(true);
    expect(isVisit({ ...TOWER, blockId: "evening" })).toBe(false);
    expect(isVisit({ ...TOWER, kind: "departure" })).toBe(false);
    expect(isVisit({ ...TOWER, spotRef: null })).toBe(false);
  });

  it("reserves the spots of visits and frames alike, but not of departures", () => {
    const refs = reservedSpotRefs([
      TOWER,
      { kind: "appointment", spotRef: "way:8", blockId: "evening" },
      { kind: "departure", spotRef: "way:9" },
      { kind: "appointment" },
    ]);
    expect([...refs].sort()).toEqual(["way:7", "way:8"]);
  });
});

describe("hosting a visit in a block", () => {
  it("opens the block after the appointment back to the way there", () => {
    const scheduled = scheduleDay({ blocks: DAY, fixpoints: [TOWER] });
    const hosted = hostVisits(scheduled.blocks, [TOWER]);

    const after = hosted.find((b) => b.id === "afternoon")!;
    const original = scheduled.blocks.find((b) => b.id === after.id)!;
    // 14:00 less the quarter hour there.
    expect(after.startMinutes).toBe(13 * 60 + 45);
    // The block keeps every minute it had, plus the visit's.
    expect(after.budgetMinutes).toBe(original.budgetMinutes + (original.startMinutes - after.startMinutes));
    // Nothing before it moved.
    const before = hosted.filter((b) => b.startMinutes < after.startMinutes);
    for (const block of before) {
      expect(block).toEqual(scheduled.blocks.find((b) => b.id === block.id));
      expect(block.startMinutes + block.budgetMinutes).toBeLessThanOrEqual(after.startMinutes);
    }
  });

  it("closes the last block when nothing comes after the appointment", () => {
    const late: Fixpoint = { ...TOWER, startMinutes: 19 * 60, durationMinutes: 60 };
    const scheduled = scheduleDay({ blocks: DAY, fixpoints: [late] });
    const hosted = hostVisits(scheduled.blocks, [late]);
    const last = hosted[hosted.length - 1];
    expect(last.startMinutes + last.budgetMinutes).toBe(20 * 60);
    expect(hostOf(hosted, late.startMinutes)).toEqual({ block: last, at: "end" });
  });

  it("finds the same host again in the stored blocks", () => {
    const scheduled = scheduleDay({ blocks: DAY, fixpoints: [TOWER] });
    const hosted = hostVisits(scheduled.blocks, [TOWER]);
    // Detailing a day later reads the stored blocks; a second pass must
    // not open the block a second time.
    expect(hostVisits(hosted, [TOWER])).toEqual(hosted);
    expect(hostOf(hosted, TOWER.startMinutes)?.at).toBe("start");
  });

  it("leaves a day without visits as it was", () => {
    const scheduled = scheduleDay({ blocks: DAY, fixpoints: [{ ...TOWER, spotRef: null }] });
    expect(hostVisits(scheduled.blocks, [{ ...TOWER, spotRef: null }])).toEqual(scheduled.blocks);
  });
});

describe("planning the day around the visit", () => {
  it("keeps the spot out of the solver and puts it at the appointment, pinned", () => {
    const scheduled = scheduleDay({ blocks: DAY, fixpoints: [TOWER] });
    const hosted = hostVisits(scheduled.blocks, [TOWER]);
    const framed = framedSpotsOf([TOWER], hosted);
    const host = hostOf(hosted, TOWER.startMinutes)!.block;

    expect(framed).toEqual([{
      blockId: host.id,
      osmRef: "way:7",
      dwellMinutes: 90,
      reserveMinutes: 105,
    }]);

    const pool = [candidate("way:7", 400), candidate("way:8", 600)];
    expect(withoutFramed(pool, framed).map((c) => c.osmRef)).toEqual(["way:8"]);

    // The solver gets the block without the visit's minutes, not an
    // empty block: the afternoon goes on after the tower.
    const forSolver = budgetsForSolver(hosted, framed);
    expect(forSolver.find((b) => b.id === host.id)!.budgetMinutes).toBe(host.budgetMinutes - 105);

    const solved: PlannedBlock[] = hosted.map((b) => ({
      id: b.id, label: b.label, kind: b.kind, budgetMinutes: 0, usedMinutes: 0, stops: [],
    }));
    const { blocks, missing } = placeFramed(solved, framed, pool, hosted, HOME, "foot");
    expect(missing).toEqual([]);
    const placed = blocks.find((b) => b.id === host.id)!;
    expect(placed.stops.map((s) => s.osmRef)).toEqual(["way:7"]);
    expect(placed.stops[0].pinned).toBe(true);
    expect(placed.stops[0].dwellMinutes).toBe(90);
    expect(placed.budgetMinutes).toBe(host.budgetMinutes);
  });

  it("puts a visit at the end of the day behind the block's other stops", () => {
    const late: Fixpoint = { ...TOWER, startMinutes: 19 * 60, durationMinutes: 60 };
    const scheduled = scheduleDay({ blocks: DAY, fixpoints: [late] });
    const hosted = hostVisits(scheduled.blocks, [late]);
    const framed = framedSpotsOf([late], hosted);
    expect(framed[0].at).toBe("end");

    const last = hosted[hosted.length - 1];
    const solved: PlannedBlock[] = hosted.map((b) => ({
      id: b.id, label: b.label, kind: b.kind, budgetMinutes: b.budgetMinutes, usedMinutes: 0,
      stops: b.id === last.id
        ? [{
          ...candidate("way:1", 200),
          reasons: [],
          travelFromPrevious: { minutes: 0, distanceM: 0, travelClass: "short_walk" as const },
        }]
        : [],
    }));
    const { blocks } = placeFramed(solved, framed, [candidate("way:7", 400)], hosted, HOME, "foot");
    expect(blocks.find((b) => b.id === last.id)!.stops.map((s) => s.osmRef)).toEqual(["way:1", "way:7"]);
  });

  it("places nothing for a visit on a day without blocks, but still reserves the spot", () => {
    expect(framedSpotsOf([TOWER], [])).toEqual([]);
    expect(reservedSpotRefs([TOWER]).has("way:7")).toBe(true);
  });
});
