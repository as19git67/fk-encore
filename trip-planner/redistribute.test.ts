import { describe, expect, it } from "vitest";
import { DISPLACEMENT_BOOST, redistribute, type CurrentBlock, type CurrentStop } from "./redistribute";
import type { Candidate } from "./solver";
import { walkingLeg } from "./travel";

const ANCHOR = { lat: 48.37, lon: 10.9 };

/** North of the anchor by roughly `metres`. */
function north(metres: number) {
  return { lat: ANCHOR.lat + metres / 111_320, lon: ANCHOR.lon };
}

function stop(ref: string, metres: number, over: Partial<CurrentStop> = {}): CurrentStop {
  const at = north(metres);
  return {
    osmRef: ref,
    name: ref,
    lat: at.lat,
    lon: at.lon,
    category: "sight",
    dwellMinutes: 30,
    score: 2,
    travelFromPrevious: walkingLeg(ANCHOR, at),
    status: "planned",
    pinned: false,
    ...over,
  };
}

function candidate(ref: string, metres: number, over: Partial<Candidate> = {}): Candidate {
  const at = north(metres);
  return {
    osmRef: ref,
    name: ref,
    lat: at.lat,
    lon: at.lon,
    category: "sight",
    dwellMinutes: 30,
    score: 2,
    ...over,
  };
}

function block(id: string, stops: CurrentStop[], budget = 210): CurrentBlock {
  return { id, label: id, kind: "spots", budgetMinutes: budget, usedMinutes: 0, stops };
}

const BASE = {
  position: north(200),
  anchor: ANCHOR,
  maxWalkMinutes: 40,
};

describe("redistribute", () => {
  it("leaves blocks before the current one untouched", () => {
    const morning = block("morning", [stop("node:a", 200, { status: "done" })]);
    const afternoon = block("afternoon", [stop("node:b", 400)]);

    const { blocks } = redistribute({
      ...BASE,
      blocks: [morning, afternoon],
      pool: [],
      currentBlockId: "afternoon",
      remainingMinutes: 120,
    });

    expect(blocks[0]).toBe(morning);
  });

  it("keeps done and skipped stops exactly where they are", () => {
    const done = stop("node:seen", 150, { status: "done" });
    const skipped = stop("node:passed", 180, { status: "skipped" });

    const { blocks } = redistribute({
      ...BASE,
      blocks: [block("morning", [done, skipped, stop("node:next", 400)])],
      pool: [],
      currentBlockId: "morning",
      remainingMinutes: 120,
    });

    const refs = blocks[0].stops.map((s) => s.osmRef);
    expect(refs.slice(0, 2)).toEqual(["node:seen", "node:passed"]);
    expect(blocks[0].stops[0].status).toBe("done");
    expect(blocks[0].stops[1].status).toBe("skipped");
  });

  it("never moves a pinned stop, even when the budget is tight", () => {
    const pinned = stop("node:booked", 900, { pinned: true, dwellMinutes: 60 });

    const { blocks } = redistribute({
      ...BASE,
      blocks: [block("morning", [pinned, stop("node:loose", 300)])],
      pool: [],
      currentBlockId: "morning",
      remainingMinutes: 70,
    });

    expect(blocks[0].stops.map((s) => s.osmRef)).toContain("node:booked");
  });

  it("recomputes from where the group actually stands", () => {
    // The group is a kilometre from the anchor. A candidate right next
    // to them should win over one back at the anchor, which a solve
    // starting from the anchor would have preferred.
    //
    // Two blocks on purpose: in the *last* spots block the walk home is
    // charged too, and then a stop near the anchor is genuinely cheaper
    // — correct, but it would hide what this test is about.
    const { blocks } = redistribute({
      ...BASE,
      position: north(1_000),
      blocks: [block("morning", [], 60), block("afternoon", [], 60)],
      pool: [candidate("node:near", 1_050), candidate("node:far", 50)],
      currentBlockId: "morning",
      remainingMinutes: 60,
    });

    expect(blocks[0].stops.map((s) => s.osmRef)).toEqual(["node:near"]);
  });

  it("returns displaced stops to the pool with a boost rather than dropping them", () => {
    const loser = stop("node:cut", 800, { dwellMinutes: 90, score: 1 });

    const { pool, displaced } = redistribute({
      ...BASE,
      blocks: [block("morning", [loser], 30)],
      pool: [],
      currentBlockId: "morning",
      remainingMinutes: 30,
    });

    expect(displaced.map((c) => c.osmRef)).toEqual(["node:cut"]);
    const back = pool.find((c) => c.osmRef === "node:cut");
    expect(back?.score).toBe(1 + DISPLACEMENT_BOOST);
  });

  it("drops what scored lowest when not everything fits", () => {
    const { blocks, displaced } = redistribute({
      ...BASE,
      position: north(300),
      blocks: [
        block(
          "morning",
          [
            stop("node:loved", 320, { score: 5, dwellMinutes: 40 }),
            stop("node:meh", 340, { score: 1, dwellMinutes: 40 }),
          ],
          50,
        ),
      ],
      pool: [],
      currentBlockId: "morning",
      remainingMinutes: 50,
    });

    expect(blocks[0].stops.map((s) => s.osmRef)).toEqual(["node:loved"]);
    expect(displaced.map((c) => c.osmRef)).toEqual(["node:meh"]);
  });

  it("fills the freed time from the pool", () => {
    const { blocks } = redistribute({
      ...BASE,
      position: north(300),
      blocks: [block("morning", [], 120)],
      pool: [candidate("node:new", 350, { score: 3 })],
      currentBlockId: "morning",
      remainingMinutes: 120,
    });

    expect(blocks[0].stops.map((s) => s.osmRef)).toEqual(["node:new"]);
  });

  it("respects the shortened budget of the current block", () => {
    const { blocks } = redistribute({
      ...BASE,
      position: north(300),
      blocks: [block("morning", [], 210)],
      pool: [
        candidate("node:a", 320, { dwellMinutes: 60 }),
        candidate("node:b", 360, { dwellMinutes: 60 }),
        candidate("node:c", 400, { dwellMinutes: 60 }),
      ],
      currentBlockId: "morning",
      remainingMinutes: 70,
    });

    expect(blocks[0].usedMinutes).toBeLessThanOrEqual(70);
    expect(blocks[0].stops.length).toBe(1);
  });

  it("recomputes the leg from the group's position, not from the old plan", () => {
    const here = north(500);
    const { blocks } = redistribute({
      ...BASE,
      position: here,
      blocks: [block("morning", [], 120)],
      pool: [candidate("node:x", 800)],
      currentBlockId: "morning",
      remainingMinutes: 120,
    });

    expect(blocks[0].stops[0].travelFromPrevious.minutes).toBe(
      walkingLeg(here, north(800)).minutes,
    );
  });

  it("later blocks keep their own budget", () => {
    const { blocks } = redistribute({
      ...BASE,
      position: north(300),
      blocks: [block("morning", [], 210), block("afternoon", [], 210)],
      pool: [
        candidate("node:a", 320, { dwellMinutes: 60, score: 4 }),
        candidate("node:b", 360, { dwellMinutes: 60, score: 3 }),
      ],
      currentBlockId: "morning",
      remainingMinutes: 20,
    });

    expect(blocks[0].stops).toEqual([]);
    expect(blocks[1].stops.length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const args = {
      ...BASE,
      position: north(300),
      blocks: [block("morning", [stop("node:keep", 320)], 210)],
      pool: [candidate("node:p", 400), candidate("node:q", 420)],
      currentBlockId: "morning",
      remainingMinutes: 180,
    } as const;
    expect(JSON.stringify(redistribute({ ...args }))).toBe(
      JSON.stringify(redistribute({ ...args })),
    );
  });

  it("rejects an unknown current block rather than guessing", () => {
    expect(() =>
      redistribute({
        ...BASE,
        blocks: [block("morning", [])],
        pool: [],
        currentBlockId: "evening",
        remainingMinutes: 60,
      }),
    ).toThrow(/unknown block/);
  });
});
