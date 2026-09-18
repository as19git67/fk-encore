/**
 * Dragging a spot between blocks and days (§8.4).
 *
 * "Budgets rechnen sich sofort neu, ein überfüllter Block wird rot" is
 * arithmetic, and the part that is easy to get wrong is how far the
 * recomputation has to reach: a block starts where the previous one
 * left off, so taking the last spot out of the morning moves the start
 * of the afternoon. Patching only the two blocks either side of a move
 * would leave the rest of the day describing a walk nobody takes.
 */

import { describe, expect, it } from "vitest";
import { MoveError, moveStop, recomputeDay } from "./move";
import type { CurrentBlock, CurrentStop } from "./redistribute";
import { travelLeg } from "./travel";

/** Invented spots strung north of an invented anchor. */
const ANCHOR = { lat: 48.37, lon: 10.9 };
/** The ordinary day: out of the quarters in the morning, back at night. */
const HOME = { start: ANCHOR, end: ANCHOR };

function north(metres: number) {
  return { lat: ANCHOR.lat + metres / 111_320, lon: ANCHOR.lon };
}

function stop(ref: string, metres: number, dwell = 30, status: CurrentStop["status"] = "planned"): CurrentStop {
  return {
    osmRef: ref,
    name: ref,
    ...north(metres),
    category: "sight",
    dwellMinutes: dwell,
    score: 2,
    travelFromPrevious: { minutes: 0, distanceM: 0, travelClass: "short_walk" },
    status,
    pinned: false,
  };
}

function block(id: string, budget: number, stops: CurrentStop[] = [], kind: "spots" | "meal" = "spots"): CurrentBlock {
  return { id, label: id, kind, budgetMinutes: budget, usedMinutes: 0, stops };
}

/** Morning with two spots, a meal block, an afternoon with one. */
function day(): CurrentBlock[] {
  return [
    block("morning", 210, [stop("node:a", 300), stop("node:b", 600)]),
    block("midday", 90, [], "meal"),
    block("afternoon", 210, [stop("node:c", 900)]),
  ];
}

describe("moving a spot within a day", () => {
  it("puts it where it was dropped", () => {
    const blocks = day();
    const res = moveStop({
      fromBlocks: blocks,
      toBlocks: blocks,
      osmRef: "node:a",
      toBlockId: "afternoon",
      toPosition: 0,
      walk: HOME,
    });

    expect(res.fromBlocks[0].stops.map((s) => s.osmRef)).toEqual(["node:b"]);
    expect(res.fromBlocks[2].stops.map((s) => s.osmRef)).toEqual(["node:a", "node:c"]);
    // One day means one array, so a caller that saves both does not
    // write half the change twice.
    expect(res.toBlocks).toBe(res.fromBlocks);
  });

  it("appends when no position is given", () => {
    const blocks = day();
    const res = moveStop({
      fromBlocks: blocks,
      toBlocks: blocks,
      osmRef: "node:a",
      toBlockId: "afternoon",
      walk: HOME,
    });
    expect(res.fromBlocks[2].stops.map((s) => s.osmRef)).toEqual(["node:c", "node:a"]);
  });

  it("clamps a position past the end rather than leaving a hole", () => {
    const blocks = day();
    const res = moveStop({
      fromBlocks: blocks,
      toBlocks: blocks,
      osmRef: "node:a",
      toBlockId: "afternoon",
      toPosition: 99,
      walk: HOME,
    });
    expect(res.fromBlocks[2].stops.map((s) => s.osmRef)).toEqual(["node:c", "node:a"]);
  });

  it("recomputes the whole day, not just the two blocks it touched", () => {
    // The afternoon starts where the morning ended. Taking node:b out
    // of the morning moves that hand-over, so the afternoon's first
    // walk is a different walk — even though the afternoon is neither
    // the source nor the target.
    const blocks = day();
    const before = blocks[2].stops[0].travelFromPrevious;

    const res = moveStop({
      fromBlocks: blocks,
      toBlocks: blocks,
      osmRef: "node:b",
      toBlockId: "afternoon",
      toPosition: 1,
      walk: HOME,
    });

    const afternoonFirst = res.fromBlocks[2].stops[0];
    expect(afternoonFirst.osmRef).toBe("node:c");
    // From node:a (300 m) rather than from node:b (600 m).
    expect(afternoonFirst.travelFromPrevious).toEqual(travelLeg(north(300), north(900)));
    expect(afternoonFirst.travelFromPrevious.minutes).not.toBe(before.minutes);
  });
});

describe("moving a spot to another day", () => {
  it("leaves it in the target day and takes it out of the source", () => {
    const from = day();
    const to = [block("morning", 210, [stop("node:x", 200)])];

    const res = moveStop({
      fromBlocks: from,
      toBlocks: to,
      osmRef: "node:a",
      toBlockId: "morning",
      toPosition: 0,
      walk: HOME,
    });

    expect(res.fromBlocks[0].stops.map((s) => s.osmRef)).toEqual(["node:b"]);
    expect(res.toBlocks[0].stops.map((s) => s.osmRef)).toEqual(["node:a", "node:x"]);
  });

  it("recomputes both days", () => {
    const from = day();
    const to = [block("morning", 210, [stop("node:x", 200)])];

    const res = moveStop({
      fromBlocks: from,
      toBlocks: to,
      osmRef: "node:a",
      toBlockId: "morning",
      toPosition: 0,
      walk: HOME,
    });

    // The day it left: the morning now walks anchor → node:b.
    expect(res.fromBlocks[0].stops[0].travelFromPrevious).toEqual(travelLeg(ANCHOR, north(600)));
    // The day it joined: anchor → node:a → node:x.
    expect(res.toBlocks[0].stops[0].travelFromPrevious).toEqual(travelLeg(ANCHOR, north(300)));
    expect(res.toBlocks[0].stops[1].travelFromPrevious).toEqual(travelLeg(north(300), north(200)));
  });

  it("does not touch the array it was handed", () => {
    const from = day();
    const to = [block("morning", 210, [stop("node:x", 200)])];
    moveStop({ fromBlocks: from, toBlocks: to, osmRef: "node:a", toBlockId: "morning", walk: HOME });

    expect(from[0].stops.map((s) => s.osmRef)).toEqual(["node:a", "node:b"]);
    expect(to[0].stops.map((s) => s.osmRef)).toEqual(["node:x"]);
  });
});

describe("two days that happen in different places (§4.5)", () => {
  /** An outing forty kilometres north: its own day, its own walk. */
  const OUTING = north(40_000);
  const AWAY = { start: OUTING, end: OUTING };

  /** A spot `metres` beyond the outing, so it is a walk once you are there. */
  function outingStop(ref: string, metres: number): CurrentStop {
    return { ...stop(ref, 0), ...north(40_000 + metres) };
  }

  it("rewalks the day that received the spot around its own ends", () => {
    const source = [block("morning", 210, [outingStop("node:a", 300)])];
    const target = [block("morning", 210, [outingStop("node:x", 600)])];

    const res = moveStop({
      fromBlocks: source,
      toBlocks: target,
      osmRef: "node:a",
      toBlockId: "morning",
      walk: AWAY,
      toWalk: AWAY,
    });

    // Both spots are within a kilometre of the outing, so the morning
    // is two short walks and the way back.
    expect(res.toBlocks[0].usedMinutes).toBeLessThan(90);
  });

  it("would charge the drive twice if the target kept the quarters", () => {
    // What the bug did: the receiving day was rewalked from the leg's
    // anchor, so its first leg became the forty-kilometre drive and its
    // last block paid for the way back as well.
    const source = [block("morning", 210, [outingStop("node:a", 300)])];
    const target = [block("morning", 210, [outingStop("node:x", 600)])];

    const wrong = moveStop({
      fromBlocks: source,
      toBlocks: target,
      osmRef: "node:a",
      toBlockId: "morning",
      walk: AWAY,
      toWalk: HOME,
    });

    expect(wrong.toBlocks[0].usedMinutes).toBeGreaterThan(400);
  });

  it("uses one walk for both when the move stays inside a day", () => {
    // `toWalk` omitted is what a move within one day is, and the day
    // must not fall back on the quarters because of it.
    const blocks = [
      block("morning", 210, [outingStop("node:a", 300)]),
      block("afternoon", 210, [outingStop("node:b", 600)]),
    ];

    const res = moveStop({
      fromBlocks: blocks,
      toBlocks: blocks,
      osmRef: "node:a",
      toBlockId: "afternoon",
      walk: AWAY,
    });

    expect(res.fromBlocks[1].usedMinutes).toBeLessThan(120);
  });
});

describe("an overfull block", () => {
  it("is reported rather than refused", () => {
    // The traveller dragged it there on purpose. Turning the block red
    // says more than a rejected gesture (§8.4).
    const blocks = [
      block("morning", 210, [stop("node:a", 300, 90), stop("node:b", 600, 90)]),
      block("afternoon", 60, [stop("node:c", 900, 45)]),
    ];

    const res = moveStop({
      fromBlocks: blocks,
      toBlocks: blocks,
      osmRef: "node:a",
      toBlockId: "afternoon",
      walk: HOME,
    });

    expect(res.overfullBlockIds).toEqual(["afternoon"]);
    // And the move happened anyway.
    expect(res.fromBlocks[1].stops.map((s) => s.osmRef)).toEqual(["node:c", "node:a"]);
  });

  it("says nothing when everything still fits", () => {
    const blocks = day();
    const res = moveStop({
      fromBlocks: blocks,
      toBlocks: blocks,
      osmRef: "node:a",
      toBlockId: "afternoon",
      walk: HOME,
    });
    expect(res.overfullBlockIds).toEqual([]);
  });
});

describe("what cannot be dropped where", () => {
  it("refuses a meal block", () => {
    // A meal block is time and a rough area, never a venue (§10.3).
    // Accepting a museum into it would quietly make it something else.
    const blocks = day();
    expect(() =>
      moveStop({ fromBlocks: blocks, toBlocks: blocks, osmRef: "node:a", toBlockId: "midday", walk: HOME }),
    ).toThrow(MoveError);
  });

  it("refuses a stop that is not in the source day", () => {
    const blocks = day();
    expect(() =>
      moveStop({ fromBlocks: blocks, toBlocks: blocks, osmRef: "node:zzz", toBlockId: "afternoon", walk: HOME }),
    ).toThrow(/not in this day/);
  });

  it("refuses a block the target day does not have", () => {
    const blocks = day();
    expect(() =>
      moveStop({ fromBlocks: blocks, toBlocks: blocks, osmRef: "node:a", toBlockId: "evening", walk: HOME }),
    ).toThrow(/no block 'evening'/);
  });
});

describe("recomputing a day", () => {
  it("charges the way back to the anchor to the last block with spots", () => {
    const blocks = day();
    recomputeDay(blocks, HOME);

    // The afternoon holds the last spot, so it pays for the walk home.
    const walkHome = travelLeg(north(900), ANCHOR).minutes;
    const afternoon = blocks[2];
    expect(afternoon.usedMinutes).toBe(
      30 + afternoon.stops[0].travelFromPrevious.minutes + walkHome,
    );
    // The morning pays for no return: it hands over to the afternoon.
    const morning = blocks[0];
    expect(morning.usedMinutes).toBe(
      morning.stops.reduce((sum, s) => sum + s.dwellMinutes + s.travelFromPrevious.minutes, 0),
    );
  });

  it("does not charge a block for a stop that is already past", () => {
    // A done or skipped stop is still on the card and still on the way,
    // but it no longer spends the budget (§5).
    const blocks = [
      block("morning", 210, [stop("node:a", 300, 90, "done"), stop("node:b", 600, 90)]),
    ];
    recomputeDay(blocks, HOME);

    const [a, b] = blocks[0].stops;
    const walkHome = travelLeg(north(600), ANCHOR).minutes;
    expect(blocks[0].usedMinutes).toBe(90 + b.travelFromPrevious.minutes + walkHome);
    // The done stop still has its walk computed — it is on the map.
    expect(a.travelFromPrevious.minutes).toBeGreaterThan(0);
  });

  it("leaves an empty day at zero", () => {
    const blocks = [block("morning", 210)];
    recomputeDay(blocks, HOME);
    expect(blocks[0].usedMinutes).toBe(0);
  });
});

describe("rewalking a day with a route in it (§4.7)", () => {
  it("goes on from the route's end, and pays the way home from there", () => {
    const routeEnd = north(8_000);
    const route: CurrentStop = {
      ...stop("manual:route", 200, 90),
      category: "route",
      extent: { end: routeEnd },
    };
    const beyond = stop("node:beyond", 8_300);
    const blocks = [block("morning", 600, [route, beyond])];

    recomputeDay(blocks, HOME);

    // The viewpoint just past the end is a short walk from it — not
    // the eight kilometres it is from the route's start.
    expect(blocks[0].stops[1].travelFromPrevious.distanceM).toBeLessThan(600);
    // And the day's last leg home is measured from where the group is.
    const home = travelLeg(north(8_300), ANCHOR).minutes;
    const walkIn = blocks[0].stops[0].travelFromPrevious.minutes;
    const walkOn = blocks[0].stops[1].travelFromPrevious.minutes;
    expect(blocks[0].usedMinutes).toBe(walkIn + 90 + walkOn + 30 + home);
  });
});
