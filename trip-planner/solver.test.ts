import { describe, expect, it } from "vitest";
import { shapeDay, type BlockTemplate } from "./blocks";
import { solveDay, type Candidate } from "./solver";
import { walkingLeg } from "./travel";

/** A compact synthetic city; places are invented. */
const ANCHOR = { lat: 48.37, lon: 10.9 };

function candidate(overrides: Partial<Candidate> & { osmRef: string }): Candidate {
  return {
    name: overrides.osmRef,
    lat: ANCHOR.lat,
    lon: ANCHOR.lon,
    category: "sight",
    dwellMinutes: 30,
    score: 1,
    ...overrides,
  };
}

/** North of the anchor by roughly `metres`. */
function north(metres: number): { lat: number; lon: number } {
  return { lat: ANCHOR.lat + metres / 111_320, lon: ANCHOR.lon };
}

const ONE_SPOTS_BLOCK: BlockTemplate[] = [
  { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 210 },
];

function blocksOf(templates: BlockTemplate[] = ONE_SPOTS_BLOCK) {
  return shapeDay(templates, "normal");
}

describe("solveDay", () => {
  it("never exceeds a block budget", () => {
    const candidates = Array.from({ length: 12 }, (_, i) =>
      candidate({ osmRef: `node:${i}`, ...north(100 * (i + 1)), dwellMinutes: 60 }),
    );
    const { blocks } = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf(),
      candidates,
      maxWalkMinutes: 40,
    });
    expect(blocks[0].usedMinutes).toBeLessThanOrEqual(blocks[0].budgetMinutes);
    expect(blocks[0].stops.length).toBeGreaterThan(0);
  });

  it("prefers the higher-scoring spot when only one fits", () => {
    const tight: BlockTemplate[] = [
      { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 45 },
    ];
    const { blocks } = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf(tight),
      candidates: [
        candidate({ osmRef: "node:dull", ...north(200), score: 1 }),
        candidate({ osmRef: "node:great", ...north(200), score: 5 }),
      ],
      maxWalkMinutes: 40,
    });
    expect(blocks[0].stops.map((s) => s.osmRef)).toEqual(["node:great"]);
  });

  it("orders the chosen stops to keep the walking short", () => {
    // Two blocks on purpose: the *last* spots block pays for the walk
    // back to the anchor, and on a straight line an out-and-back tour
    // costs the same in every order — every segment is walked twice. So
    // the assertion only means something in a block that does not
    // return, which is what the morning block is here.
    const day: BlockTemplate[] = [
      { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 210 },
      { id: "evening", label: "Abend", kind: "spots", baseBudgetMinutes: 120 },
    ];
    // Fed in deliberately scrambled; the tour should come out in order.
    const { blocks } = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf(day),
      candidates: [
        candidate({ osmRef: "node:c", ...north(900), dwellMinutes: 20 }),
        candidate({ osmRef: "node:a", ...north(300), dwellMinutes: 20 }),
        candidate({ osmRef: "node:b", ...north(600), dwellMinutes: 20 }),
      ],
      maxWalkMinutes: 40,
    });
    expect(blocks[0].stops.map((s) => s.osmRef)).toEqual(["node:a", "node:b", "node:c"]);
  });

  it("picks the cheaper tour when the order genuinely matters", () => {
    // A triangle: visiting the far corner between the two near ones
    // walks the long edge twice.
    const day: BlockTemplate[] = [
      { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 240 },
      { id: "evening", label: "Abend", kind: "spots", baseBudgetMinutes: 120 },
    ];
    const near1 = { lat: ANCHOR.lat + 0.002, lon: ANCHOR.lon };
    const near2 = { lat: ANCHOR.lat + 0.002, lon: ANCHOR.lon + 0.004 };
    const far = { lat: ANCHOR.lat + 0.012, lon: ANCHOR.lon + 0.002 };

    const { blocks } = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf(day),
      candidates: [
        candidate({ osmRef: "node:far", ...far, dwellMinutes: 20 }),
        candidate({ osmRef: "node:near1", ...near1, dwellMinutes: 20 }),
        candidate({ osmRef: "node:near2", ...near2, dwellMinutes: 20 }),
      ],
      maxWalkMinutes: 40,
    });
    const order = blocks[0].stops.map((s) => s.osmRef);
    expect(order).toHaveLength(3);
    expect(order[2]).toBe("node:far");
  });

  it("prefers variety over a third helping of the same category", () => {
    const tight: BlockTemplate[] = [
      { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 120 },
    ];
    const { blocks } = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf(tight),
      candidates: [
        candidate({ osmRef: "node:church1", ...north(200), category: "worship", score: 2 }),
        candidate({ osmRef: "node:church2", ...north(300), category: "worship", score: 2 }),
        candidate({ osmRef: "node:church3", ...north(400), category: "worship", score: 2 }),
        candidate({ osmRef: "node:view", ...north(350), category: "viewpoint", score: 1.6 }),
      ],
      maxWalkMinutes: 40,
    });
    const categories = blocks[0].stops.map((s) => s.category);
    expect(categories).toContain("viewpoint");
    expect(categories.filter((c) => c === "worship").length).toBeLessThan(3);
  });

  it("refuses a leg longer than maxWalkMinutes", () => {
    const { blocks, unplaced } = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf(),
      candidates: [candidate({ osmRef: "node:far", ...north(6_000), score: 9 })],
      maxWalkMinutes: 20,
    });
    expect(blocks[0].stops).toEqual([]);
    expect(unplaced.map((c) => c.osmRef)).toEqual(["node:far"]);
  });

  it("leaves meal blocks empty — a slot, not a venue", () => {
    const day: BlockTemplate[] = [
      { id: "midday", label: "Mittag", kind: "meal", baseBudgetMinutes: 90 },
      { id: "afternoon", label: "Nachmittag", kind: "spots", baseBudgetMinutes: 210 },
    ];
    const { blocks } = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf(day),
      candidates: [candidate({ osmRef: "node:a", ...north(300) })],
      maxWalkMinutes: 40,
    });
    expect(blocks[0].kind).toBe("meal");
    expect(blocks[0].stops).toEqual([]);
    expect(blocks[0].usedMinutes).toBe(0);
    expect(blocks[1].stops.map((s) => s.osmRef)).toEqual(["node:a"]);
  });

  it("charges the walk back to the anchor to the last block", () => {
    const spot = north(1_000);
    const single: BlockTemplate[] = [
      { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 210 },
    ];
    const { blocks } = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf(single),
      candidates: [candidate({ osmRef: "node:a", ...spot, dwellMinutes: 30 })],
      maxWalkMinutes: 40,
    });
    const out = walkingLeg(ANCHOR, spot).minutes;
    // Out and back plus the dwell — not just the outward leg.
    expect(blocks[0].usedMinutes).toBe(out * 2 + 30);
  });

  it("uses each candidate at most once across the day", () => {
    const day: BlockTemplate[] = [
      { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 210 },
      { id: "afternoon", label: "Nachmittag", kind: "spots", baseBudgetMinutes: 210 },
    ];
    const candidates = Array.from({ length: 6 }, (_, i) =>
      candidate({ osmRef: `node:${i}`, ...north(150 * (i + 1)), dwellMinutes: 40 }),
    );
    const { blocks } = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf(day),
      candidates,
      maxWalkMinutes: 40,
    });
    const refs = blocks.flatMap((b) => b.stops.map((s) => s.osmRef));
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("returns unplaced candidates best first", () => {
    const tight: BlockTemplate[] = [
      { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 40 },
    ];
    const { unplaced } = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf(tight),
      candidates: [
        candidate({ osmRef: "node:low", ...north(400), score: 1 }),
        candidate({ osmRef: "node:high", ...north(500), score: 4 }),
        candidate({ osmRef: "node:mid", ...north(600), score: 2 }),
      ],
      maxWalkMinutes: 40,
    });
    const scores = unplaced.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("is deterministic, including when scores tie", () => {
    const candidates = [
      candidate({ osmRef: "node:b", ...north(300), score: 2 }),
      candidate({ osmRef: "node:a", ...north(300), score: 2 }),
      candidate({ osmRef: "node:c", ...north(310), score: 2 }),
    ];
    const run = () =>
      solveDay({
        anchor: ANCHOR,
        blocks: blocksOf(),
        candidates,
        maxWalkMinutes: 40,
      });
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
    // Same input in a different order must still give the same plan.
    const reversed = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf(),
      candidates: [...candidates].reverse(),
      maxWalkMinutes: 40,
    });
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(run()));
  });

  it("copes with no candidates at all", () => {
    const { blocks, unplaced } = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf(),
      candidates: [],
      maxWalkMinutes: 40,
    });
    expect(blocks[0].stops).toEqual([]);
    expect(blocks[0].usedMinutes).toBe(0);
    expect(unplaced).toEqual([]);
  });

  it("leaves room in the day rather than filling it with what nobody wants", () => {
    // Room is not a reason to go somewhere (§6.1). Every candidate the
    // search produces starts positive, so this can only exclude a spot
    // the group voted below zero — and it is still not a veto: enough
    // "will ich" lifts it back over the line.
    const { blocks } = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf(),
      candidates: [
        candidate({ osmRef: "node:wanted", ...north(300), dwellMinutes: 20, score: 2 }),
        candidate({ osmRef: "node:voted-down", ...north(400), dwellMinutes: 20, score: -1 }),
      ],
      maxWalkMinutes: 40,
    });

    expect(blocks[0].stops.map((stop) => stop.osmRef)).toEqual(["node:wanted"]);
  });

  it("reports the walk from the previous stop, not from the anchor", () => {
    const { blocks } = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf(),
      candidates: [
        candidate({ osmRef: "node:a", ...north(300), dwellMinutes: 20 }),
        candidate({ osmRef: "node:b", ...north(600), dwellMinutes: 20 }),
      ],
      maxWalkMinutes: 40,
    });
    const [first, second] = blocks[0].stops;
    expect(first.travelFromPrevious.minutes).toBe(walkingLeg(ANCHOR, north(300)).minutes);
    expect(second.travelFromPrevious.minutes).toBe(walkingLeg(north(300), north(600)).minutes);
  });
});

describe("the two ends of a day (§4.4)", () => {
  /** South of the anchor by roughly `metres` — the station's side. */
  function south(metres: number): { lat: number; lon: number } {
    return { lat: ANCHOR.lat - metres / 111_320, lon: ANCHOR.lon };
  }

  const STATION = south(1_500);

  it("returns to the anchor when nothing says otherwise", () => {
    const { blocks } = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf(),
      candidates: [candidate({ osmRef: "node:north", ...north(600) })],
      maxWalkMinutes: 40,
    });
    expect(blocks[0].stops.map((s) => s.osmRef)).toEqual(["node:north"]);
  });

  it("orders the last block towards where the day ends", () => {
    // Two spots on opposite sides. Ending at the station makes the
    // southern one the last stop; ending at the hotel does not.
    const spots = [
      candidate({ osmRef: "node:north", ...north(600) }),
      candidate({ osmRef: "node:south", ...south(600) }),
    ];
    const toStation = solveDay({
      anchor: ANCHOR, end: STATION, blocks: blocksOf(), candidates: spots, maxWalkMinutes: 40,
    });
    expect(toStation.blocks[0].stops.at(-1)?.osmRef).toBe("node:south");

    const toHotel = solveDay({
      anchor: ANCHOR, blocks: blocksOf(), candidates: spots, maxWalkMinutes: 40,
    });
    // Symmetric around the anchor, so the tie-break on the ref decides —
    // what matters is that it is not the station's answer by accident.
    expect(toHotel.blocks[0].stops.at(-1)?.osmRef).toBe("node:south");
    expect(toHotel.blocks[0].usedMinutes).not.toBe(toStation.blocks[0].usedMinutes);
  });

  it("sets off from where the travellers actually are", () => {
    // Arriving at the station, the spot beside it is the cheap one —
    // from the hotel it is the far one.
    const spots = [
      candidate({ osmRef: "node:by-station", ...south(1_400), dwellMinutes: 90 }),
      candidate({ osmRef: "node:by-hotel", ...north(200), dwellMinutes: 90 }),
    ];
    const tight: BlockTemplate[] = [
      { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 120 },
    ];
    const fromStation = solveDay({
      anchor: ANCHOR, start: STATION, blocks: blocksOf(tight),
      candidates: spots, maxWalkMinutes: 40,
    });
    expect(fromStation.blocks[0].stops.map((s) => s.osmRef)).toEqual(["node:by-station"]);

    const fromHotel = solveDay({
      anchor: ANCHOR, blocks: blocksOf(tight), candidates: spots, maxWalkMinutes: 40,
    });
    expect(fromHotel.blocks[0].stops.map((s) => s.osmRef)).toEqual(["node:by-hotel"]);
  });

  it("costs the walk to the station rather than the walk home", () => {
    const spot = candidate({ osmRef: "node:north", ...north(600) });
    const home = solveDay({
      anchor: ANCHOR, blocks: blocksOf(), candidates: [spot], maxWalkMinutes: 40,
    });
    const station = solveDay({
      anchor: ANCHOR, end: STATION, blocks: blocksOf(), candidates: [spot], maxWalkMinutes: 40,
    });
    // 600 m back to the hotel against 2 100 m on to the platform.
    expect(station.blocks[0].usedMinutes).toBeGreaterThan(home.blocks[0].usedMinutes);
    expect(station.blocks[0].usedMinutes - home.blocks[0].usedMinutes)
      .toBeCloseTo(walkingLeg(spot, STATION).minutes - walkingLeg(spot, ANCHOR).minutes, 0);
  });
});

describe("a spot with an extent (§4.7)", () => {
  // A route: it starts near the anchor and finishes eight kilometres
  // north. The day goes on from where it ends, not from where it began.
  const ROUTE_END = north(8_000);
  const route = candidate({
    osmRef: "manual:route",
    ...north(200),
    category: "route",
    dwellMinutes: 90,
    score: 5,
    extent: { end: ROUTE_END, lengthM: 10_000 },
  });

  it("measures the next walk from the route's end", () => {
    // A viewpoint 300 m beyond the route's end: from the end it is a
    // short walk, from the start it would be a two-hour march no block
    // allows. Only the first reading lets it into the day.
    const beyond = candidate({ osmRef: "node:beyond", ...north(8_300), score: 3 });
    const { blocks } = solveDay({
      anchor: ANCHOR,
      // The day ends where the route does — a car left at the far end.
      end: ROUTE_END,
      blocks: blocksOf([
        { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 240 },
      ]),
      candidates: [route, beyond],
      maxWalkMinutes: 40,
    });
    const refs = blocks[0].stops.map((s) => s.osmRef);
    expect(refs).toEqual(["manual:route", "node:beyond"]);
    const walkOn = blocks[0].stops[1].travelFromPrevious;
    expect(walkOn.distanceM).toBeLessThan(600);
    // And the extent rides along on the stop, for the rewalks after.
    expect(blocks[0].stops[0].extent).toEqual({ end: ROUTE_END, lengthM: 10_000 });
  });

  it("charges the way back from the route's end, not its start", () => {
    // The route alone in a block that must return to the anchor: the
    // eight-kilometre walk back is what the block pays for. Measured
    // from the start it would cost nothing and the block would lie.
    const { blocks } = solveDay({
      anchor: ANCHOR,
      blocks: blocksOf([
        { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 600 },
      ]),
      candidates: [route],
      maxWalkMinutes: 400,
    });
    expect(blocks[0].stops.map((s) => s.osmRef)).toEqual(["manual:route"]);
    const back = walkingLeg(ROUTE_END, ANCHOR).minutes;
    expect(blocks[0].usedMinutes).toBeGreaterThanOrEqual(90 + back);
  });

  it("hands the next block on from the route's end", () => {
    const beyond = candidate({ osmRef: "node:beyond", ...north(8_300), score: 3 });
    const { blocks } = solveDay({
      anchor: ANCHOR,
      end: ROUTE_END,
      blocks: blocksOf([
        { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 100 },
        { id: "afternoon", label: "Nachmittag", kind: "spots", baseBudgetMinutes: 100 },
      ]),
      candidates: [route, beyond],
      maxWalkMinutes: 40,
    });
    expect(blocks[0].stops.map((s) => s.osmRef)).toEqual(["manual:route"]);
    expect(blocks[1].stops.map((s) => s.osmRef)).toEqual(["node:beyond"]);
    expect(blocks[1].stops[0].travelFromPrevious.distanceM).toBeLessThan(600);
  });
});

describe("what a route walks past (§4.7)", () => {
  const ROUTE_END = north(8_000);
  /** East of a point by roughly `metres`, at this latitude. */
  function east(of: { lat: number; lon: number }, metres: number) {
    return { lat: of.lat, lon: of.lon + metres / (111_320 * Math.cos((of.lat * Math.PI) / 180)) };
  }
  const route = candidate({
    osmRef: "manual:route",
    ...north(200),
    category: "route",
    dwellMinutes: 90,
    score: 5,
    extent: { end: ROUTE_END },
  });

  it("does not also plan a viewpoint that lies on the route", () => {
    // Eighty metres off the line, halfway along: you walk past it.
    const onTheWay = candidate({ osmRef: "node:on", ...east(north(4_000), 80), score: 4 });
    const { blocks, unplaced } = solveDay({
      anchor: ANCHOR,
      end: ROUTE_END,
      blocks: blocksOf([
        { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 600 },
      ]),
      candidates: [route, onTheWay],
      maxWalkMinutes: 400,
    });
    expect(blocks[0].stops.map((s) => s.osmRef)).toEqual(["manual:route"]);
    // Passed, not turned down: it stays available, so a day without
    // the route can still offer it.
    expect(unplaced.map((c) => c.osmRef)).toEqual(["node:on"]);
  });

  it("still plans a spot that is merely nearby", () => {
    const beside = candidate({ osmRef: "node:beside", ...east(north(4_000), 900), score: 4 });
    const { blocks } = solveDay({
      anchor: ANCHOR,
      end: ROUTE_END,
      blocks: blocksOf([
        { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 600 },
      ]),
      candidates: [route, beside],
      maxWalkMinutes: 400,
    });
    expect(blocks[0].stops.map((s) => s.osmRef).sort()).toEqual(["manual:route", "node:beside"]);
  });

  it("keeps a passed spot out of every later block too", () => {
    // You walk past it in the morning; planning it after lunch is the
    // same mistake one block later.
    const onTheWay = candidate({ osmRef: "node:on", ...east(north(4_000), 80), score: 4 });
    const { blocks } = solveDay({
      anchor: ANCHOR,
      end: ROUTE_END,
      blocks: blocksOf([
        { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 300 },
        { id: "afternoon", label: "Nachmittag", kind: "spots", baseBudgetMinutes: 300 },
      ]),
      candidates: [route, onTheWay],
      maxWalkMinutes: 400,
    });
    expect(blocks.flatMap((b) => b.stops).map((s) => s.osmRef)).toEqual(["manual:route"]);
  });
});
