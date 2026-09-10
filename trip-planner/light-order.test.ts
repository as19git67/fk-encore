/**
 * Putting the light in the right order (§7.3).
 *
 * The two halves of §7.3's sentence are the two things worth pinning
 * down: the selection must not change, and it must cost nothing. A
 * reordering that adds a walk is not free, and "free" is the whole
 * justification for doing it at all.
 */

import { describe, expect, it } from "vitest";
import { missedLight, orderCost, orderForLight } from "./light-order";

/** Everything is next door: the order is then purely about light. */
const nextDoor = () => 5;

function stop(osmRef: string, window?: [number, number]) {
  return {
    osmRef,
    dwellMinutes: 60,
    window: window ? { fromMinutes: window[0], toMinutes: window[1] } : null,
  };
}

const options = {
  startMinutes: 14 * 60,
  travelMinutes: nextDoor,
  budgetMinutes: 6 * 60,
};

describe("how badly an order misses the light", () => {
  it("is nothing when the stay falls inside the window", () => {
    // 14:05 to 15:05, middle 14:35 — inside 14:00–16:00.
    expect(missedLight([stop("a", [14 * 60, 16 * 60])], options)).toBe(0);
  });

  it("counts the minutes from the middle of the stay, not the arrival", () => {
    // Arriving at 14:05 with the window closing at 14:10 is not "in the
    // golden hour": the group is there until 15:05.
    expect(missedLight([stop("a", [13 * 60, 14 * 60 + 10])], options)).toBe(25);
  });

  it("ignores everything nobody marked as a photo stop", () => {
    expect(missedLight([stop("a"), stop("b")], options)).toBe(0);
  });
});

describe("the order the light wants", () => {
  it("moves the evening viewpoint to the end of the block", () => {
    const result = orderForLight(
      [stop("aussicht", [17 * 60, 19 * 60]), stop("gasse"), stop("hof")],
      options,
    );

    expect(result.stops.map((s) => s.osmRef)).toEqual(["gasse", "hof", "aussicht"]);
    expect(result.reordered).toBe(true);
    expect(result.missedAfter).toBeLessThan(result.missedBefore);
  });

  it("changes nothing about which spots are in the block", () => {
    // §7.3: "ändert die Auswahl nicht". Only the sequence may move.
    const stops = [stop("a", [18 * 60, 19 * 60]), stop("b"), stop("c")];

    const result = orderForLight(stops, options);

    expect(result.stops.map((s) => s.osmRef).sort()).toEqual(["a", "b", "c"]);
    expect(result.stops).toHaveLength(3);
  });

  it("leaves a block nobody photographs exactly as it was", () => {
    const stops = [stop("a"), stop("b"), stop("c")];

    const result = orderForLight(stops, options);

    expect(result.reordered).toBe(false);
    expect(result.stops.map((s) => s.osmRef)).toEqual(["a", "b", "c"]);
  });

  it("refuses an order that would not fit the block any more", () => {
    // A day that no longer adds up is a worse answer than a badly lit
    // photo (§4.1).
    const stops = [stop("aussicht", [17 * 60, 19 * 60]), stop("gasse")];

    const result = orderForLight(stops, { ...options, budgetMinutes: 60 });

    expect(result.reordered).toBe(false);
  });

  it("does not buy light with a long detour", () => {
    // Walking between these two costs 40 minutes each way; the light is
    // not worth that, and §7.3 only permits the reordering because it
    // is free.
    const far = (from: string | null, to: string) =>
      (from === null ? 5 : from === to ? 0 : 40);
    const stops = [stop("aussicht", [17 * 60, 19 * 60]), stop("gasse"), stop("hof")];

    const result = orderForLight(stops, {
      ...options, travelMinutes: far, detourBudgetMinutes: 2,
    });

    expect(result.extraTravelMinutes).toBeLessThanOrEqual(2);
  });

  it("keeps the solver's order when the light does not actually improve", () => {
    // A tie is not a reason: the route had reasons of its own.
    const stops = [stop("a", [14 * 60, 22 * 60]), stop("b", [14 * 60, 22 * 60])];

    const result = orderForLight(stops, options);

    expect(result.stops.map((s) => s.osmRef)).toEqual(["a", "b"]);
    expect(result.reordered).toBe(false);
  });

  it("handles a long block without trying every order of it", () => {
    // Eight stops is 40 320 permutations; neighbour swaps are what a
    // block that size gets, and it still has to come back sane.
    const stops = [
      stop("1"), stop("2"), stop("3"), stop("4"),
      stop("5"), stop("6"), stop("7"), stop("aussicht", [19 * 60, 20 * 60]),
    ];

    const result = orderForLight(stops, { ...options, budgetMinutes: 12 * 60 });

    expect(result.stops).toHaveLength(8);
    expect(new Set(result.stops.map((s) => s.osmRef)).size).toBe(8);
  });

  it("says what an order costs, so a caller can refuse it", () => {
    expect(orderCost([stop("a"), stop("b")], nextDoor)).toBe(130);
  });
});
