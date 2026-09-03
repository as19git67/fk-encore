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
