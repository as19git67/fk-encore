/**
 * The stop a frame brings with it (§7.3).
 *
 * The solver must not fill a block framed for the evening light with
 * museums that closed at six, must not plan the terrace on Tuesday
 * when Thursday's frame is for it, and must find the terrace in the
 * block afterwards — pinned, for as long as the light lasts, with the
 * way there and the way home counted.
 */

import { describe, expect, it } from "vitest";
import type { PlannedBlockShape } from "./blocks";
import {
  budgetsForSolver,
  framedSpotsOf,
  placeFramed,
  withoutFramed,
} from "./frame-spots";
import type { Candidate, PlannedBlock } from "./solver";
import { travelLeg } from "./travel";

const QUARTERS = { lat: 48.37, lon: 10.9 };
const HOME = { start: QUARTERS, end: QUARTERS };

function north(metres: number) {
  return { lat: QUARTERS.lat + metres / 111_320, lon: QUARTERS.lon };
}

function candidate(ref: string, metres: number, extra: Partial<Candidate> = {}): Candidate {
  return {
    osmRef: ref,
    name: ref,
    ...north(metres),
    category: "viewpoint",
    dwellMinutes: 30,
    score: 3,
    ...extra,
  };
}

function shape(id: string, budgetMinutes: number): PlannedBlockShape {
  return { id, label: id, kind: "spots", baseBudgetMinutes: budgetMinutes, budgetMinutes };
}

function emptyBlock(id: string, budgetMinutes: number): PlannedBlock {
  return { id, label: id, kind: "spots", budgetMinutes, usedMinutes: 0, stops: [] };
}

const terrace = { blockId: "evening", osmRef: "way:7", dwellMinutes: 50 };

describe("framedSpotsOf", () => {
  it("takes the appointments bound to a block and a spot, and nothing else", () => {
    const framed = framedSpotsOf([
      { kind: "appointment", blockId: "evening", spotRef: "way:7", durationMinutes: 50 },
      // An ordinary appointment: no block.
      { kind: "appointment", durationMinutes: 90 },
      // A departure can frame nothing — nothing comes after it.
      { kind: "departure", blockId: "evening", spotRef: "way:9", durationMinutes: 0 },
      // Half a binding is no binding.
      { kind: "appointment", blockId: "evening", durationMinutes: 20 },
    ]);
    expect(framed).toEqual([terrace]);
  });

  it("gives even an instant a minute of stay", () => {
    expect(framedSpotsOf([{ blockId: "evening", spotRef: "way:7", durationMinutes: 0 }]))
      .toEqual([{ blockId: "evening", osmRef: "way:7", dwellMinutes: 1 }]);
  });
});

describe("reserving the frame's spot", () => {
  it("takes it out of the candidates", () => {
    const pool = [candidate("way:7", 300), candidate("way:8", 600)];
    expect(withoutFramed(pool, [terrace]).map((c) => c.osmRef)).toEqual(["way:8"]);
  });

  it("shows the solver a framed block as full", () => {
    const shapes = [shape("afternoon", 210), shape("evening", 62)];
    expect(budgetsForSolver(shapes, [terrace]).map((s) => s.budgetMinutes)).toEqual([210, 0]);
  });

  it("changes nothing when there is no frame", () => {
    const pool = [candidate("way:7", 300)];
    const shapes = [shape("evening", 120)];
    expect(withoutFramed(pool, [])).toEqual(pool);
    expect(budgetsForSolver(shapes, [])).toEqual(shapes);
  });
});

describe("placeFramed", () => {
  it("puts the spot into its block, pinned, for as long as the light lasts", () => {
    const solved = [emptyBlock("afternoon", 210), emptyBlock("evening", 0)];
    const pool = [candidate("way:7", 900, { photoStop: true })];

    const { blocks, missing } = placeFramed(
      solved, [terrace], pool, [shape("afternoon", 210), shape("evening", 62)], HOME, "foot",
    );

    expect(missing).toEqual([]);
    const evening = blocks.find((b) => b.id === "evening")!;
    expect(evening.stops.map((s) => s.osmRef)).toEqual(["way:7"]);
    expect(evening.stops[0].pinned).toBe(true);
    // The window, not the category's usual half hour.
    expect(evening.stops[0].dwellMinutes).toBe(50);
    expect(evening.stops[0].photoStop).toBe(true);
    // And the block says how long the evening is again, not that it
    // had no room.
    expect(evening.budgetMinutes).toBe(62);
  });

  it("counts the way there and the way home", () => {
    const solved = [emptyBlock("evening", 0)];
    const pool = [candidate("way:7", 900)];

    const { blocks } = placeFramed(solved, [terrace], pool, [shape("evening", 62)], HOME, "foot");

    const stop = blocks[0].stops[0];
    const there = travelLeg(QUARTERS, north(900), "foot").minutes;
    expect(stop.travelFromPrevious.minutes).toBe(there);
    // The last block with a stop pays the way back, as every rewalk does.
    expect(blocks[0].usedMinutes).toBe(there + 50 + travelLeg(north(900), QUARTERS, "foot").minutes);
  });

  it("walks from wherever the afternoon ended", () => {
    const afternoon: PlannedBlock = {
      ...emptyBlock("afternoon", 210),
      stops: [{
        ...candidate("way:1", 300),
        reasons: [],
        travelFromPrevious: { minutes: 0, distanceM: 0, travelClass: "short_walk" },
      }],
    };
    const solved = [afternoon, emptyBlock("evening", 0)];
    const pool = [candidate("way:7", 900)];

    const { blocks } = placeFramed(
      solved, [terrace], pool, [shape("afternoon", 210), shape("evening", 62)], HOME, "foot",
    );

    const stop = blocks[1].stops[0];
    expect(stop.travelFromPrevious.minutes).toBe(travelLeg(north(300), north(900), "foot").minutes);
  });

  it("reports a frame whose spot is nowhere to be found", () => {
    // Hidden since, perhaps. Nothing is invented for the block; the
    // caller decides what to do with a frame for a place the trip
    // turned down.
    const solved = [emptyBlock("evening", 0)];
    const { blocks, missing } = placeFramed(solved, [terrace], [], [shape("evening", 62)], HOME, "foot");

    expect(missing).toEqual([terrace]);
    expect(blocks[0].stops).toEqual([]);
  });

  it("leaves a day without frames exactly as it was", () => {
    const solved = [emptyBlock("evening", 120)];
    expect(placeFramed(solved, [], [], [shape("evening", 120)], HOME, "foot"))
      .toEqual({ blocks: solved, missing: [] });
  });
});
