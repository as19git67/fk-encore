/**
 * A stop that runs past the end of its block (§4.7). Minutes only —
 * the module is arithmetic, and so is this.
 */
import { describe, expect, it } from "vitest";
import { needsMoreThanOneBlock, roomInBlock, spillOver } from "./spill";

/** The default four, as minutes: Vormittag, Mittag, Nachmittag, Abend. */
function day(used: readonly number[]) {
  const budgets = [210, 90, 210, 120];
  return budgets.map((budgetMinutes, i) => ({ budgetMinutes, usedMinutes: used[i] ?? 0 }));
}

describe("spillOver", () => {
  it("leaves an ordinary day alone", () => {
    const spill = spillOver(day([180, 0, 190, 60]));
    expect(spill.blocks.map((b) => b.carriedInMinutes)).toEqual([0, 0, 0, 0]);
    expect(spill.beyondDayMinutes).toBe(0);
  });

  it("makes lunch late when the morning runs over", () => {
    // The Ponale: four hours planned into a three-and-a-half-hour
    // Vormittag. Lunch starts thirty minutes late and, being ninety
    // minutes long, absorbs it — the afternoon begins on time.
    const spill = spillOver(day([240, 0, 190, 60]));
    expect(spill.blocks[0].overrunMinutes).toBe(30);
    expect(spill.blocks[1].carriedInMinutes).toBe(30);
    expect(spill.blocks[2].carriedInMinutes).toBe(0);
    expect(spill.beyondDayMinutes).toBe(0);
  });

  it("passes on what a block cannot absorb", () => {
    // A six-hour walk: the Vormittag runs 150 minutes over, lunch
    // swallows 90 of them and hands 60 to the afternoon.
    const spill = spillOver(day([360, 0, 190, 60]));
    expect(spill.blocks[1].carriedInMinutes).toBe(150);
    expect(spill.blocks[2].carriedInMinutes).toBe(60);
    // The afternoon had 190 of its 210 minutes spoken for; 60 late
    // plus 190 is 40 past its end, and the evening inherits those.
    expect(spill.blocks[3].carriedInMinutes).toBe(40);
    expect(spill.beyondDayMinutes).toBe(0);
  });

  it("says when the day is simply too short", () => {
    const spill = spillOver(day([600, 0, 190, 60]));
    expect(spill.beyondDayMinutes).toBeGreaterThan(0);
  });

  it("counts an empty block as room, not as a wall", () => {
    // Nothing in the afternoon: it absorbs the whole overrun rather
    // than passing it on.
    const spill = spillOver(day([300, 0, 0, 60]));
    expect(spill.blocks[1].carriedInMinutes).toBe(90);
    expect(spill.blocks[2].carriedInMinutes).toBe(0);
    expect(spill.beyondDayMinutes).toBe(0);
  });

  it("answers an empty day with an empty result", () => {
    expect(spillOver([])).toEqual({ blocks: [], beyondDayMinutes: 0 });
  });
});

describe("roomInBlock", () => {
  it("is what the overrun left of it, never less than nothing", () => {
    expect(roomInBlock(210, 0)).toBe(210);
    expect(roomInBlock(210, 30)).toBe(180);
    expect(roomInBlock(90, 150)).toBe(0);
  });
});

describe("needsMoreThanOneBlock", () => {
  const shape = [
    { kind: "spots", budgetMinutes: 210 },
    { kind: "meal", budgetMinutes: 90 },
    { kind: "spots", budgetMinutes: 210 },
  ];

  it("is false for anything a block can hold", () => {
    expect(needsMoreThanOneBlock(180, shape)).toBe(false);
    expect(needsMoreThanOneBlock(210, shape)).toBe(false);
  });

  it("is true for the four-hour walk", () => {
    expect(needsMoreThanOneBlock(240, shape)).toBe(true);
  });

  it("ignores meal blocks, which hold time rather than places", () => {
    // A long lunch block is not somewhere a walk can be planned, so it
    // must not make a walk look as though it fits (§10.3).
    const longLunch = [
      { kind: "spots", budgetMinutes: 120 },
      { kind: "meal", budgetMinutes: 300 },
    ];
    expect(needsMoreThanOneBlock(240, longLunch)).toBe(true);
  });

  it("says nothing about a day with no block for spots", () => {
    expect(needsMoreThanOneBlock(240, [{ kind: "meal", budgetMinutes: 90 }])).toBe(false);
  });
});
