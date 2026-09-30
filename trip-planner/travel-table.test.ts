/**
 * One matrix, one table, the estimate behind it.
 */

import { describe, expect, it } from "vitest";
import { InMemoryRouterClient } from "./router-client.test-helper";
import { buildTravelTable, ESTIMATE_TABLE, MAX_TABLE_POINTS } from "./travel-table";
import { solveDay, type Candidate } from "./solver";
import { travelLeg } from "./travel";

const ANCHOR = { lat: 48.37, lon: 10.9 };
const P1 = { lat: 48.372, lon: 10.905 };
const P2 = { lat: 48.375, lon: 10.91 };

function candidate(ref: string, at: { lat: number; lon: number }): Candidate {
  return { osmRef: ref, name: ref, lat: at.lat, lon: at.lon, category: "sight", dwellMinutes: 30, score: 2 };
}

describe("buildTravelTable", () => {
  it("asks the router once for every pair and answers from the table", async () => {
    const router = new InMemoryRouterClient();
    const table = await buildTravelTable([ANCHOR, P1, P2], "foot", router);
    expect(router.matrixCalls).toEqual([{ sources: 3, targets: 3, mode: "foot" }]);
    expect(table.source).toBe("router");
    expect(table.asked).toBe(6);
    expect(table.answered).toBe(6);
    const fromRouter = table.travel(ANCHOR, P1, "foot");
    expect(fromRouter.minutes).toBe(Math.round(fromRouter.distanceM / 80));
    // A pair the table never saw, or another mode: the estimate.
    expect(table.travel(ANCHOR, { lat: 48.5, lon: 11 }, "foot")).toEqual(travelLeg(ANCHOR, { lat: 48.5, lon: 11 }, "foot"));
    expect(table.travel(ANCHOR, P1, "car")).toEqual(travelLeg(ANCHOR, P1, "car"));
  });

  it("is the estimate when the router is away, refuses the mode, or the set is too large", async () => {
    const away = new InMemoryRouterClient();
    away.reachable = false;
    expect(await buildTravelTable([ANCHOR, P1], "car", away)).toBe(ESTIMATE_TABLE);
    expect(await buildTravelTable([ANCHOR, P1], "transit", new InMemoryRouterClient())).toBe(ESTIMATE_TABLE);
    const many = Array.from({ length: MAX_TABLE_POINTS + 1 }, (_, i) => ({ lat: 48 + i * 0.001, lon: 10 }));
    const counting = new InMemoryRouterClient();
    expect(await buildTravelTable(many, "car", counting)).toBe(ESTIMATE_TABLE);
    expect(counting.matrixCalls).toHaveLength(0);
  });

  it("feeds the solver, which reads and never asks", async () => {
    const router = new InMemoryRouterClient();
    // A router that walks at a crawl: the day fits less than the estimate would allow.
    router.speeds = { foot: 8 };
    const table = await buildTravelTable([ANCHOR, P1, P2], "foot", router);
    const calls = router.matrixCalls.length;
    const day = solveDay({
      anchor: ANCHOR,
      blocks: [{ id: "b1", label: "Vormittag", kind: "spots", budgetMinutes: 90, baseBudgetMinutes: 90 }],
      candidates: [candidate("node:1", P1), candidate("node:2", P2)],
      maxWalkMinutes: 40,
      mode: "foot",
      travel: table.travel,
    });
    expect(router.matrixCalls).toHaveLength(calls);
    const withEstimate = solveDay({
      anchor: ANCHOR,
      blocks: [{ id: "b1", label: "Vormittag", kind: "spots", budgetMinutes: 90, baseBudgetMinutes: 90 }],
      candidates: [candidate("node:1", P1), candidate("node:2", P2)],
      maxWalkMinutes: 40,
      mode: "foot",
    });
    expect(day.blocks[0].stops.length).toBeLessThan(withEstimate.blocks[0].stops.length);
  });
});
