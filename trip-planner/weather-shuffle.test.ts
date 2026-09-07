/**
 * Rearranging a day around the weather (§7.2).
 *
 * Half of these cases are about what the weather is *not* allowed to
 * do: touch a settled stop, move a pinned one, throw anything away, or
 * rearrange a day it has no forecast for.
 */

import { describe, expect, it } from "vitest";
import { DISPLACEMENT_BOOST, type CurrentBlock, type CurrentStop } from "./redistribute";
import type { Candidate } from "./solver";
import { shelterWanted, shuffleForWeather, swapRainyDay, weatheredBudget } from "./weather-shuffle";
import type { BlockWeather } from "./weather";

const ANCHOR = { lat: 48.14, lon: 11.58 };

function weather(over: Partial<BlockWeather> = {}): BlockWeather {
  return {
    precipitationMm: 0,
    wetness: "dry",
    cloudCover: 20,
    temperatureC: 18,
    relativeHumidity: 60,
    feelsLikeC: 18,
    heat: "mild",
    budgetFactor: 1,
    ...over,
  };
}

const WET = weather({ precipitationMm: 5, wetness: "wet", budgetFactor: 0.75 });
const DRY = weather();

let nextRef = 0;

function candidate(kind: string, over: Partial<Candidate> = {}): Candidate {
  nextRef += 1;
  return {
    osmRef: `way:${nextRef}`,
    name: `Ort ${nextRef}`,
    lat: ANCHOR.lat + nextRef * 0.0004,
    lon: ANCHOR.lon,
    category: "sight",
    kind,
    dwellMinutes: 45,
    score: 3,
    ...over,
  };
}

function stop(candidate: Candidate, over: Partial<CurrentStop> = {}): CurrentStop {
  return {
    ...candidate,
    travelFromPrevious: { minutes: 5, distanceM: 400, travelClass: "short_walk" },
    status: "planned",
    pinned: false,
    ...over,
  };
}

function block(id: string, stops: CurrentStop[], budgetMinutes = 180): CurrentBlock {
  return {
    id,
    label: id,
    kind: "spots",
    budgetMinutes,
    usedMinutes: stops.reduce((s, x) => s + x.dwellMinutes + x.travelFromPrevious.minutes, 0),
    stops,
  };
}

function run(
  blocks: CurrentBlock[],
  pool: Candidate[],
  forecast: Record<string, BlockWeather>,
) {
  return shuffleForWeather({
    blocks,
    pool,
    weather: new Map(Object.entries(forecast)),
    anchor: ANCHOR,
    maxWalkMinutes: 40,
  });
}

function refsIn(result: { blocks: CurrentBlock[] }, id: string): string[] {
  return result.blocks.find((b) => b.id === id)!.stops.map((s) => s.osmRef);
}

describe("how badly a block wants shelter", () => {
  it("wants it most in the rain", () => {
    expect(shelterWanted(WET)).toBe(1);
    expect(shelterWanted(weather({ wetness: "showers" }))).toBe(0.5);
    expect(shelterWanted(DRY)).toBe(0);
  });

  it("asks for it in the heat too, but less loudly", () => {
    // §7.2 puts a hot afternoon beside a wet one deliberately. Shade is
    // easier to find than a roof, so it asks for less.
    expect(shelterWanted(weather({ heat: "hot" }))).toBe(0.5);
    expect(shelterWanted(weather({ heat: "hot" }))).toBeLessThan(shelterWanted(WET));
  });

  it("wants nothing when nothing is known", () => {
    expect(shelterWanted(undefined)).toBe(0);
  });
});

describe("what the weather leaves of a budget", () => {
  it("shrinks it by the factor the forecast gives", () => {
    expect(weatheredBudget(block("x", [], 180), WET)).toBe(135);
  });

  it("leaves it alone where nothing is known", () => {
    expect(weatheredBudget(block("x", [], 180), undefined)).toBe(180);
  });
});

describe("whole-day weather swaps", () => {
  it("exchanges a wet day with a later dry day", () => {
    const result = swapRainyDay({
      days: [
        { id: 1, blocks: [block("morning", [stop(candidate("outdoor"))])] },
        { id: 2, blocks: [block("morning", [stop(candidate("indoor"))])] },
      ],
      weatherByDay: new Map([[1, 2], [2, 0]]),
    });
    expect(result.fromDayId).toBe(1);
    expect(result.toDayId).toBe(2);
    expect(result.days[0].blocks[0].stops[0].kind).toBe("indoor");
  });
});

describe("rearranging a day", () => {
  it("swaps an outdoor spot out of the rain for an indoor one", () => {
    const park = candidate("leisure=park");
    const museum = candidate("tourism=museum");
    const result = run(
      [block("morning", [stop(park)])],
      [museum],
      { morning: WET },
    );

    expect(refsIn(result, "morning")).toContain(museum.osmRef);
    expect(refsIn(result, "morning")).not.toContain(park.osmRef);
    expect(result.unchanged).toBe(false);
  });

  it("moves the museum to the wet block and the park to the dry one", () => {
    // The point of doing this over the whole day rather than per block:
    // one decision, two spots, and neither is lost.
    const park = candidate("leisure=park");
    const museum = candidate("tourism=museum");
    const result = run(
      [block("morning", [stop(museum)]), block("afternoon", [stop(park)])],
      [],
      { morning: DRY, afternoon: WET },
    );

    expect(refsIn(result, "afternoon")).toContain(museum.osmRef);
    expect(refsIn(result, "morning")).toContain(park.osmRef);
  });

  it("never touches a stop that has already happened", () => {
    // A done or skipped stop is the travel diary, not scheduling
    // material (§5). Rain is not an argument against a fact.
    const park = candidate("leisure=park");
    const museum = candidate("tourism=museum");
    const result = run(
      [block("morning", [stop(park, { status: "done" })])],
      [museum],
      { morning: WET },
    );

    expect(refsIn(result, "morning")[0]).toBe(park.osmRef);
  });

  it("never moves a pinned stop", () => {
    // Somebody decided this deliberately (§4.4). If they want to stand
    // in the rain, they may.
    const park = candidate("leisure=park");
    const result = run(
      [block("morning", [stop(park, { pinned: true })])],
      [candidate("tourism=museum")],
      { morning: WET },
    );

    expect(refsIn(result, "morning")).toContain(park.osmRef);
  });

  it("leaves a block it has no forecast for exactly as it was", () => {
    // No data is not a reason to rearrange somebody's day (§15.3).
    const park = candidate("leisure=park");
    const result = run(
      [block("morning", [stop(park)]), block("afternoon", [])],
      [candidate("tourism=museum")],
      { afternoon: WET },
    );

    expect(refsIn(result, "morning")).toEqual([park.osmRef]);
  });

  it("sends what it displaced to the pool, not to the bin", () => {
    const park = candidate("leisure=park");
    const museum = candidate("tourism=museum");
    const result = run(
      [block("morning", [stop(park)], 60)],
      [museum],
      { morning: WET },
    );

    const returned = result.pool.find((c) => c.osmRef === park.osmRef);
    expect(returned).toBeDefined();
    // And with the boost §5 gives a displaced stop, so it comes back
    // first on a drier day rather than starting from scratch.
    expect(returned!.score).toBe(park.score + DISPLACEMENT_BOOST);
  });

  it("respects the budget the weather left", () => {
    // 180 minutes at 0.75 is 135; three 45-minute spots plus walking do
    // not fit, and the proposal must not pretend they do.
    const result = run(
      [block("morning", [], 180)],
      [candidate("tourism=museum"), candidate("tourism=museum"), candidate("tourism=museum")],
      { morning: WET },
    );

    const used = result.blocks[0].stops
      .reduce((sum, s) => sum + s.dwellMinutes + s.travelFromPrevious.minutes, 0);
    expect(used).toBeLessThanOrEqual(135);
  });

  it("proposes nothing when there is nothing worth proposing", () => {
    // A no-op prompt is worse than silence: it teaches people to
    // dismiss it.
    const museum = candidate("tourism=museum");
    const result = run([block("morning", [stop(museum)])], [], { morning: WET });

    expect(result.unchanged).toBe(true);
    expect(result.moves).toHaveLength(0);
  });

  it("changes nothing on a dry day", () => {
    const park = candidate("leisure=park");
    const result = run([block("morning", [stop(park)])], [candidate("tourism=museum")], {
      morning: DRY,
    });

    expect(refsIn(result, "morning")).toEqual([park.osmRef]);
    expect(result.unchanged).toBe(true);
  });

  it("refuses a spot too far to walk to, weather or not", () => {
    const faraway = candidate("tourism=museum", { lat: 49.5, lon: 11.58 });
    const result = run([block("morning", [])], [faraway], { morning: WET });

    expect(refsIn(result, "morning")).toHaveLength(0);
  });

  it("names every move it proposes", () => {
    const park = candidate("leisure=park");
    const museum = candidate("tourism=museum");
    const result = run([block("morning", [stop(park)])], [museum], { morning: WET });

    const named = result.moves.map((m) => m.osmRef);
    expect(named).toContain(park.osmRef);
    expect(named).toContain(museum.osmRef);
    // Out of the day entirely, rather than into another block.
    expect(result.moves.find((m) => m.osmRef === park.osmRef)?.toBlockId).toBeNull();
  });

  it("recomputes the walk so the card does not lie about it", () => {
    const park = candidate("leisure=park");
    const museum = candidate("tourism=museum");
    const result = run([block("morning", [stop(park)])], [museum], { morning: WET });

    const placed = result.blocks[0].stops[0];
    expect(placed.osmRef).toBe(museum.osmRef);
    expect(placed.travelFromPrevious.minutes).toBeGreaterThan(0);
    expect(result.blocks[0].usedMinutes).toBeGreaterThan(placed.dwellMinutes);
  });

  it("does not fill an empty block from the pool because it rains", () => {
    // Topping a day up is the planner's job at planning time, not the
    // weather's at eight in the morning. This proposes swaps; a day
    // with a gap in it had that gap before the forecast arrived.
    const result = run([block("morning", [])], [candidate("tourism=museum")], { morning: WET });

    expect(result.blocks[0].stops).toHaveLength(0);
    expect(result.unchanged).toBe(true);
  });

  it("sheds the weakest spot when the weather leaves too little budget", () => {
    // Three museums fit a dry morning and not a wet one. What goes is
    // what scored lowest — §5's rule, not a new one.
    const strong = candidate("tourism=museum", { score: 9, dwellMinutes: 60 });
    const middling = candidate("tourism=museum", { score: 5, dwellMinutes: 60 });
    const weakest = candidate("tourism=museum", { score: 1, dwellMinutes: 60 });
    const result = run(
      [block("morning", [stop(strong), stop(middling), stop(weakest)], 200)],
      [],
      { morning: weather({ wetness: "wet", budgetFactor: 0.75 }) },
    );

    expect(refsIn(result, "morning")).toContain(strong.osmRef);
    expect(refsIn(result, "morning")).not.toContain(weakest.osmRef);
    expect(result.moves.some((m) => m.reason === "budget")).toBe(true);
  });
});
