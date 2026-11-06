import { describe, expect, it } from "vitest";
import { fameValue, germanCount, monthlyAverage, prominenceOf, TIER_POINTS, type SpotFame } from "./prominence";
import { MANUAL_SCORE } from "./candidates";

const fame = (pageviews: number | null, languages: number | null = null, extra: Partial<SpotFame> = {}): SpotFame => ({
  pageviews, languages, commonsFiles: null, wikivoyage: null, ...extra,
});

describe("prominenceOf", () => {
  it("ranks within the pool, so a village and a capital each have a top quarter", () => {
    const village = new Map([
      ["a", fame(40)], ["b", fame(120)], ["c", fame(600)], ["d", fame(2_000)],
    ]);
    const capital = new Map([
      ["a", fame(4_000)], ["b", fame(12_000)], ["c", fame(60_000)], ["d", fame(200_000)],
    ]);
    expect(prominenceOf(village).get("d")?.tier).toBe(3);
    expect(prominenceOf(capital).get("d")?.tier).toBe(3);
    expect(prominenceOf(village).get("a")?.tier).toBe(0);
  });

  it("tells a cathedral from a side chapel where the old tag sum tied them", () => {
    const pool = new Map([
      ["dom", fame(18_000, 40, { commonsFiles: 900, wikivoyage: "Gotischer Dom mit zwei Türmen." })],
      ["kapelle", fame(90, 2)],
    ]);
    const ranked = prominenceOf(pool);
    expect(ranked.get("dom")!.points).toBeGreaterThan(ranked.get("kapelle")!.points);
    expect(ranked.get("dom")!.reasons).toEqual([
      "in Wikivoyage genannt", "18.000 Aufrufe im Monat", "Artikel in 40 Sprachen", "über 900 Bilder auf Commons",
    ]);
    // Ninety readers a month is a fact, not a recommendation.
    expect(ranked.get("kapelle")!.reasons).toEqual([]);
  });

  it("never lifts a place over one somebody added", () => {
    expect(1 + Math.max(...TIER_POINTS) + 0.5).toBeLessThan(MANUAL_SCORE);
  });

  it("leaves out a place nobody answered for", () => {
    const ranked = prominenceOf(new Map([["x", fame(null)], ["y", fame(500)]]));
    expect(ranked.has("x")).toBe(false);
    expect(ranked.get("y")?.tier).toBe(2);
  });

  it("counts a listing without a description as a listing", () => {
    expect(fameValue(fame(null, null, { wikivoyage: "" }))).toBe(1);
  });
});

describe("numbers on the card", () => {
  it("writes them the German way", () => {
    expect(germanCount(12_000)).toBe("12.000");
    expect(germanCount(950)).toBe("950");
  });

  it("averages the months it has", () => {
    expect(monthlyAverage([100, 200, 300])).toBe(200);
    expect(monthlyAverage([])).toBeNull();
  });
});
