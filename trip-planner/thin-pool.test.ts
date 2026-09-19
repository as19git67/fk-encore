/**
 * The measurement behind §4.6's suggestion.
 *
 * Everything here is one question: may the planner bring up a day
 * trip at all? Getting it wrong in one direction is useless (four days
 * in a small town and not a word about the city an hour away), in the
 * other it is overbearing (an hour in the car because one afternoon
 * ran short).
 */
import { describe, expect, it } from "vitest";
import { measureThinPool, type ThinPoolDay } from "./thin-pool";

/** A day of two blocks with four hours each. */
function day(
  dayIndex: number,
  used: [number, number],
  extra: Partial<ThinPoolDay> = {},
): ThinPoolDay {
  return {
    dayIndex,
    hasOwnAnchor: false,
    blocks: [
      { budgetMinutes: 240, usedMinutes: used[0] },
      { budgetMinutes: 240, usedMinutes: used[1] },
    ],
    ...extra,
  };
}

function spots(count: number, dwellMinutes = 60) {
  return Array.from({ length: count }, () => ({ dwellMinutes }));
}

describe("a leg whose pool does not carry its days", () => {
  it("is thin when a day would stay empty after the pool gave everything", () => {
    // Four days of eight hours; the pool filled two of them and has
    // nothing left. This is San Gimignano.
    const verdict = measureThinPool({
      days: [day(0, [240, 240]), day(1, [240, 240]), day(2, [0, 0]), day(3, [0, 0])],
      pool: [],
    });

    expect(verdict.thin).toBe(true);
    expect(verdict.reason).toBe("thin");
    expect(verdict.emptyMinutes).toBe(960);
    expect(verdict.uncoveredMinutes).toBe(960);
    expect(verdict.dayMinutes).toBe(480);
  });

  it("names the emptiest day first, because that is the one to send away", () => {
    const verdict = measureThinPool({
      days: [day(0, [240, 240]), day(1, [240, 0]), day(2, [0, 0]), day(3, [240, 240])],
      pool: [],
    });
    expect(verdict.freeDays).toEqual([2, 1]);
  });
});

describe("what must not count as thin", () => {
  it("stays quiet while the pool can still fill the gaps", () => {
    // Eight hours empty and nine hours of pool: those blocks are empty
    // for some other reason, and a day trip answers nothing.
    const verdict = measureThinPool({
      days: [day(0, [240, 240]), day(1, [240, 240]), day(2, [0, 0]), day(3, [240, 240])],
      pool: spots(9),
    });
    expect(verdict.thin).toBe(false);
    expect(verdict.reason).toBe("pool-has-more");
  });

  it("is not thin because one afternoon came up short", () => {
    // §4.6 is explicit: undersupplied means the days do not carry, not
    // that a block is short. Half a day spread over four is not a day.
    const verdict = measureThinPool({
      days: [day(0, [240, 190]), day(1, [240, 200]), day(2, [220, 240]), day(3, [240, 210])],
      pool: [],
    });
    expect(verdict.thin).toBe(false);
    expect(verdict.reason).toBe("pool-has-more");
    expect(verdict.uncoveredMinutes).toBeLessThan(verdict.dayMinutes);
  });

  it("says nothing about a full leg", () => {
    const verdict = measureThinPool({
      days: [day(0, [240, 240]), day(1, [240, 240])],
      pool: [],
    });
    expect(verdict.thin).toBe(false);
    expect(verdict.reason).toBe("days-are-full");
    expect(verdict.freeDays).toEqual([]);
  });

  it("leaves a single day alone", () => {
    // There is nothing to go *instead of*: a trip would replace the
    // leg rather than fill it, and that is the traveller's call.
    const verdict = measureThinPool({ days: [day(0, [0, 0])], pool: [] });
    expect(verdict.thin).toBe(false);
    expect(verdict.reason).toBe("too-few-days");
  });
});

describe("the days that are no evidence either way", () => {
  it("does not count a day that already goes somewhere else", () => {
    // Two days at the base, two already out on trips: the leg is two
    // days long as far as this question goes, and they are full.
    const verdict = measureThinPool({
      days: [
        day(0, [240, 240]),
        day(1, [240, 240]),
        day(2, [0, 0], { hasOwnAnchor: true }),
        day(3, [0, 0], { hasOwnAnchor: true }),
      ],
      pool: [],
    });
    expect(verdict.thin).toBe(false);
    expect(verdict.emptyMinutes).toBe(0);
  });

  it("does not count the buffer day, which is empty on purpose", () => {
    const verdict = measureThinPool({
      days: [
        day(0, [240, 240]),
        day(1, [240, 240]),
        day(2, [0, 0], { bufferReason: "Im Mittel regnet es hier jeden dritten Tag" }),
      ],
      pool: [],
    });
    expect(verdict.thin).toBe(false);
    expect(verdict.freeDays).toEqual([]);
  });

  it("measures a day of this leg by this leg's own days", () => {
    // Short days: a trip-sized hole is six hours here, not eight.
    const short = (dayIndex: number, used: [number, number]): ThinPoolDay => ({
      dayIndex,
      hasOwnAnchor: false,
      blocks: [
        { budgetMinutes: 180, usedMinutes: used[0] },
        { budgetMinutes: 180, usedMinutes: used[1] },
      ],
    });
    const verdict = measureThinPool({
      days: [short(0, [180, 180]), short(1, [180, 180]), short(2, [0, 0])],
      pool: [],
    });
    expect(verdict.dayMinutes).toBe(360);
    expect(verdict.thin).toBe(true);
  });
});

describe("arithmetic that must not go negative", () => {
  it("ignores a block that ran over its budget rather than crediting it", () => {
    // A stop may run past the end of its block (§4.7); that is not
    // spare capacity somewhere else.
    const verdict = measureThinPool({
      days: [
        { dayIndex: 0, hasOwnAnchor: false, blocks: [{ budgetMinutes: 240, usedMinutes: 400 }] },
        { dayIndex: 1, hasOwnAnchor: false, blocks: [{ budgetMinutes: 240, usedMinutes: 0 }] },
      ],
      pool: [],
    });
    expect(verdict.emptyMinutes).toBe(240);
    expect(verdict.thin).toBe(true);
  });

  it("never reports less than nothing uncovered", () => {
    const verdict = measureThinPool({
      days: [day(0, [0, 0]), day(1, [0, 0])],
      pool: spots(40),
    });
    expect(verdict.uncoveredMinutes).toBe(0);
    expect(verdict.thin).toBe(false);
  });
});
