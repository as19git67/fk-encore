/**
 * The frame of a day, and what it costs the blocks inside it (§4.4).
 *
 * The case that matters is the last train: the day has to stop early
 * enough to walk to the station with a margin, and the block that runs
 * into that edge has to say so rather than quietly overrunning. These
 * tests work in minutes past midnight so the arithmetic is visible —
 * 1120 is 18:40.
 */

import { describe, expect, it } from "vitest";
import type { PlannedBlockShape } from "./blocks";
import {
  DEFAULT_BUFFER_MINUTES,
  MIN_BUFFER_MINUTES,
  formatMinutes,
  parseMinutes,
  resolveFixpoints,
  scheduleDay,
} from "./fixpoints";

const at = (h: number, m = 0) => h * 60 + m;

function block(id: string, budgetMinutes: number): PlannedBlockShape {
  return { id, label: id, kind: "spots", baseBudgetMinutes: budgetMinutes, budgetMinutes };
}

/** 09:00–12:30, 12:30–14:00, 14:00–17:30, 17:30–19:30. */
const DAY: PlannedBlockShape[] = [
  block("morning", 210),
  block("midday", 90),
  block("afternoon", 210),
  block("evening", 120),
];

describe("a day with no fixpoints", () => {
  it("leaves every budget exactly as it was", () => {
    const { blocks, dropped } = scheduleDay({ blocks: DAY });
    expect(dropped).toEqual([]);
    expect(blocks.map((b) => b.budgetMinutes)).toEqual([210, 90, 210, 120]);
    expect(blocks.map((b) => b.startMinutes)).toEqual([
      at(9),
      at(12, 30),
      at(14),
      at(17, 30),
    ]);
  });

  it("starts where the caller says the day starts", () => {
    const { blocks } = scheduleDay({ blocks: DAY, dayStartMinutes: at(7, 30) });
    expect(blocks[0].startMinutes).toBe(at(7, 30));
  });
});

describe("the last train", () => {
  const lastTrain = {
    id: "train",
    label: "Letzter Zug 18:40",
    kind: "departure" as const,
    startMinutes: at(18, 40),
    travelMinutes: 15,
    bufferMinutes: 20,
  };

  it("cuts the evening back from the departure, not from its own length", () => {
    // The evening would run 17:30–19:30. The train binds at
    // 18:40 − 15 travel − 20 buffer = 18:05, so 35 minutes are left.
    const { blocks, dropped } = scheduleDay({ blocks: DAY, fixpoints: [lastTrain] });
    expect(dropped).toEqual([]);

    const evening = blocks.find((b) => b.id === "evening")!;
    expect(evening.startMinutes).toBe(at(17, 30));
    expect(evening.budgetMinutes).toBe(35);
    // The block remembers what it used to be, so the app can say what
    // the train cost.
    expect(evening.originalBudgetMinutes).toBe(120);
  });

  it("leaves the earlier blocks untouched", () => {
    const { blocks } = scheduleDay({ blocks: DAY, fixpoints: [lastTrain] });
    expect(blocks.slice(0, 3).map((b) => b.budgetMinutes)).toEqual([210, 90, 210]);
  });

  it("drops the block a train leaves no room for, and says which train", () => {
    const early = { ...lastTrain, label: "Letzter Zug 17:45", startMinutes: at(17, 45) };
    const { blocks, dropped } = scheduleDay({ blocks: DAY, fixpoints: [early] });

    // Binds at 17:10, so the afternoon (from 14:00) gets 190 and the
    // evening never begins.
    expect(blocks.map((b) => b.id)).toEqual(["morning", "midday", "afternoon"]);
    expect(blocks[2].budgetMinutes).toBe(190);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].id).toBe("evening");
    expect(dropped[0].reason).toContain("Letzter Zug 17:45");
  });

  it("binds harder the longer the way to the station", () => {
    const near = scheduleDay({ blocks: DAY, fixpoints: [{ ...lastTrain, travelMinutes: 5 }] });
    const far = scheduleDay({ blocks: DAY, fixpoints: [{ ...lastTrain, travelMinutes: 45 }] });

    // 18:40 − 5 − 20 = 18:15, so 45 minutes of the evening survive.
    expect(near.blocks.find((b) => b.id === "evening")?.budgetMinutes).toBe(45);
    // 18:40 − 45 − 20 = 17:35, five minutes: not a block at all.
    expect(far.blocks.map((b) => b.id)).not.toContain("evening");
    expect(far.dropped.map((d) => d.id)).toEqual(["evening"]);
  });

  it("plans nothing after the train has gone", () => {
    // The mistake this guards against is treating a departure like an
    // appointment: the day would carry on at 17:45 with an evening
    // block behind a train that has already left.
    const early = { ...lastTrain, label: "Letzter Zug 17:45", startMinutes: at(17, 45) };
    const { blocks, dropped } = scheduleDay({ blocks: DAY, fixpoints: [early] });
    const last = blocks[blocks.length - 1];
    expect(last.startMinutes + last.budgetMinutes).toBeLessThanOrEqual(at(17, 10));
    expect(dropped.map((d) => d.id)).toEqual(["evening"]);
  });
});

describe("a booked slot in the middle of the day", () => {
  const tour = {
    id: "tour",
    label: "Führung 14:00",
    startMinutes: at(14),
    durationMinutes: 90,
    travelMinutes: 10,
    bufferMinutes: 10,
  };

  it("takes the time it occupies out of the day, not out of one budget", () => {
    const { blocks, dropped } = scheduleDay({ blocks: DAY, fixpoints: [tour] });
    expect(dropped).toEqual([]);

    // Binds at 13:40, so midday (12:30) keeps 70 of its 90 minutes.
    const midday = blocks.find((b) => b.id === "midday")!;
    expect(midday.budgetMinutes).toBe(70);

    // The afternoon cannot start until the tour is over at 15:30.
    const afternoon = blocks.find((b) => b.id === "afternoon")!;
    expect(afternoon.startMinutes).toBe(at(15, 30));
    expect(afternoon.budgetMinutes).toBe(210);
  });

  it("pushes everything after it later, and the evening with it", () => {
    const { blocks } = scheduleDay({ blocks: DAY, fixpoints: [tour] });
    const evening = blocks.find((b) => b.id === "evening")!;
    // 15:30 + 210 = 19:00.
    expect(evening.startMinutes).toBe(at(19));
  });
});

describe("several fixpoints in one day", () => {
  it("lets the earliest one bind, whatever order they arrive in", () => {
    const dinner = { id: "dinner", label: "Tisch 19:00", startMinutes: at(19) };
    const train = { id: "train", label: "Zug 18:30", startMinutes: at(18, 30) };

    // The train binds at 18:10, the dinner at 18:40. The evening starts
    // at 17:30 and gets the earlier of the two edges: 40 minutes.
    const { blocks } = scheduleDay({ blocks: DAY, fixpoints: [dinner, train] });
    expect(blocks.find((b) => b.id === "evening")!.budgetMinutes).toBe(40);

    // And the same however they are passed in.
    const reversed = scheduleDay({ blocks: DAY, fixpoints: [train, dinner] });
    expect(reversed.blocks.find((b) => b.id === "evening")!.budgetMinutes).toBe(40);
  });

  it("reports them sorted by when they bind, not by when they happen", () => {
    const late = { id: "late", label: "Spät", startMinutes: at(20), travelMinutes: 0 };
    const early = { id: "early", label: "Früh", startMinutes: at(21), travelMinutes: 120 };
    // 'early' happens later but binds earlier: 21:00 − 120 − 20 = 18:40
    // against 20:00 − 20 = 19:40.
    const { fixpoints } = scheduleDay({ blocks: DAY, fixpoints: [late, early] });
    expect(fixpoints.map((f) => f.id)).toEqual(["early", "late"]);
  });
});

describe("the buffer", () => {
  it("defaults to twenty minutes", () => {
    const [fix] = resolveFixpoints([{ id: "x", label: "x", startMinutes: at(18) }]);
    expect(fix.bufferMinutes).toBe(DEFAULT_BUFFER_MINUTES);
    expect(fix.guardStartMinutes).toBe(at(18) - DEFAULT_BUFFER_MINUTES);
  });

  it("is never zero, however the caller asks", () => {
    // Missing a train costs more than a skipped spot (§4.4), so this is
    // a floor rather than a default.
    for (const asked of [0, -30]) {
      const [fix] = resolveFixpoints([
        { id: "x", label: "x", startMinutes: at(18), bufferMinutes: asked },
      ]);
      expect(fix.bufferMinutes).toBe(MIN_BUFFER_MINUTES);
    }
  });

  it("is kept when the caller wants more of it", () => {
    const [fix] = resolveFixpoints([
      { id: "x", label: "x", startMinutes: at(18), bufferMinutes: 60 },
    ]);
    expect(fix.bufferMinutes).toBe(60);
  });
});

describe("clock formatting", () => {
  it("round-trips a time of day", () => {
    expect(formatMinutes(at(18, 40))).toBe("18:40");
    expect(parseMinutes("18:40")).toBe(at(18, 40));
    expect(formatMinutes(at(9, 5))).toBe("09:05");
    expect(parseMinutes("09:05")).toBe(at(9, 5));
  });

  it("refuses what is not a time of day", () => {
    for (const bad of ["", "abends", "25:00", "18:60", "18", "18:4", "2026-09-04"]) {
      expect(parseMinutes(bad), bad).toBeNull();
    }
  });
});
