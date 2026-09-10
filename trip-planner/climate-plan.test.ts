/**
 * What a climate normal is allowed to change (§7.2).
 *
 * The rule these cases exist for is a limit rather than a feature: a
 * monthly average may produce **precautions**, never a day plan. So the
 * cases worth pinning down are the ones where it says nothing, and the
 * one where saying "no buffer" is the honest answer.
 */

import { describe, expect, it } from "vitest";
import {
  bufferDayIndex,
  indoorReadiness,
  precautionsFor,
  wetShare,
  HOT_MONTH_MEAN_C,
  WET_MONTH_INDOOR_SHARE,
} from "./climate-plan";

/** A dry, mild month: nothing to prepare for. */
const mild = { month: 5, meanTemperatureC: 16, precipitationMm: 55, wetDays: 8 };
/** A wet one: every third day. */
const wet = { month: 9, meanTemperatureC: 21, precipitationMm: 210, wetDays: 12 };
/** A hot one, dry. */
const hot = { month: 7, meanTemperatureC: 29, precipitationMm: 20, wetDays: 3 };

describe("what a month asks for", () => {
  it("asks for nothing when it is neither wet nor hot", () => {
    const precautions = precautionsFor(mild, 5);

    expect(precautions.reasons).toEqual([]);
    expect(precautions.bufferDays).toBe(0);
    expect(precautions.indoorShare).toBeNull();
  });

  it("names the wet month in a sentence somebody can argue with", () => {
    const precautions = precautionsFor(wet, 5);

    expect(precautions.reasons[0]).toContain("September");
    expect(precautions.reasons[0]).toContain("Regentage");
    expect(precautions.indoorShare).toBe(WET_MONTH_INDOOR_SHARE);
  });

  it("counts heat as its own reason", () => {
    const precautions = precautionsFor(hot, 5);

    expect(precautions.reasons.some((r) => r.includes("°C"))).toBe(true);
    expect(precautions.indoorShare).toBe(WET_MONTH_INDOOR_SHARE);
    expect(hot.meanTemperatureC).toBeGreaterThanOrEqual(HOT_MONTH_MEAN_C);
  });

  it("leaves one day free, never two", () => {
    // §7.2 says "ein Puffertag je Etappe". A planner that empties a
    // quarter of the holiday has stopped being one.
    expect(precautionsFor(wet, 5).bufferDays).toBe(1);
    expect(precautionsFor(wet, 14).bufferDays).toBe(1);
  });

  it("says a short leg has no day to spare, instead of taking it", () => {
    const precautions = precautionsFor(wet, 2);

    expect(precautions.bufferDays).toBe(0);
    expect(precautions.reasons.join(" ")).toContain("zu kurz");
  });
});

describe("which day stays free", () => {
  it("is in the middle, not the arrival or the departure", () => {
    // A buffer on either end is not spare time; it is the day that was
    // already half gone.
    expect(bufferDayIndex(5, 1)).toBe(2);
    expect(bufferDayIndex(3, 1)).toBe(1);
  });

  it("is nowhere when the leg is too short or nothing asked", () => {
    expect(bufferDayIndex(2, 1)).toBeNull();
    expect(bufferDayIndex(7, 0)).toBeNull();
  });
});

describe("would this pool survive a wet morning", () => {
  const pool = [
    { osmRef: "a", shelter: "indoor" },
    { osmRef: "b", shelter: "partly" },
    { osmRef: "c", shelter: "outdoor" },
    { osmRef: "d", shelter: "outdoor" },
  ];

  it("counts a cloister as shelter, because a shower makes it one", () => {
    expect(indoorReadiness(pool, WET_MONTH_INDOOR_SHARE).share).toBe(0.5);
    expect(indoorReadiness(pool, WET_MONTH_INDOOR_SHARE).enough).toBe(true);
  });

  it("says how many more are needed rather than just 'not enough'", () => {
    const thin = [
      { osmRef: "a", shelter: "outdoor" },
      { osmRef: "b", shelter: "outdoor" },
      { osmRef: "c", shelter: "outdoor" },
    ];

    const readiness = indoorReadiness(thin, WET_MONTH_INDOOR_SHARE);

    expect(readiness.enough).toBe(false);
    expect(readiness.shortfall).toBe(1);
  });

  it("has no opinion when the month asked for nothing", () => {
    expect(indoorReadiness(pool, null).enough).toBe(true);
    expect(indoorReadiness(pool, null).shortfall).toBe(0);
  });

  it("says an empty pool is short of whatever was asked", () => {
    expect(indoorReadiness([], 0.3)).toMatchObject({ share: 0, enough: false });
  });
});

describe("the wet share", () => {
  it("reads days per month as a share", () => {
    expect(wetShare({ ...wet, wetDays: 15 })).toBe(0.5);
  });

  it("does not let a broken number leave the range", () => {
    expect(wetShare({ ...wet, wetDays: -3 })).toBe(0);
    expect(wetShare({ ...wet, wetDays: 99 })).toBeLessThanOrEqual(31 / 30);
  });
});
