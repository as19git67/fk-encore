import { describe, it, expect } from "vitest";
import { parseChart, pickSymbol } from "./quote-provider-yahoo";

// Shapes as Yahoo's endpoints answer them, with invented securities.

describe("pickSymbol", () => {
  it("prefers the Xetra listing over the others", () => {
    const picked = pickSymbol([
      { symbol: "SNN.F", exchange: "FRA", longname: "Sonnenobst AG", quoteType: "EQUITY" },
      { symbol: "SNN.DE", exchange: "GER", longname: "Sonnenobst AG", quoteType: "EQUITY" },
      { symbol: "SNN", exchange: "NMS", longname: "Sonnenobst AG", quoteType: "EQUITY" },
    ]);
    expect(picked).toEqual({ symbol: "SNN.DE", name: "Sonnenobst AG", exchange: "GER", currency: null });
  });

  it("takes the first match when no German venue lists it", () => {
    expect(pickSymbol([{ symbol: "SNN", exchange: "NMS", shortname: "Sonnenobst" }])?.symbol).toBe("SNN");
  });

  it("skips derivatives and answers null for nothing usable", () => {
    expect(pickSymbol([{ symbol: "SNN260101C", exchange: "OPR", quoteType: "OPTION" }])).toBeNull();
    expect(pickSymbol([])).toBeNull();
  });
});

describe("parseChart", () => {
  it("reads the closes with their times and skips minutes without a trade", () => {
    const s = parseChart(
      {
        chart: {
          result: [
            {
              meta: { currency: "EUR", symbol: "SNN.DE" },
              timestamp: [1_770_000_000, 1_770_000_300, 1_770_000_600],
              indicators: { quote: [{ close: [10.5, null, 10.75] }] },
            },
          ],
        },
      },
      "SNN.DE",
    );
    expect(s.currency).toBe("EUR");
    expect(s.points).toEqual([
      { at: "2026-02-02T02:40:00.000Z", price: 10.5 },
      { at: "2026-02-02T02:50:00.000Z", price: 10.75 },
    ]);
  });

  it("appends the regular market price when it is newer than the last bar", () => {
    const s = parseChart(
      {
        chart: {
          result: [
            {
              meta: { currency: "EUR", regularMarketPrice: 11, regularMarketTime: 1_770_000_900 },
              timestamp: [1_770_000_000],
              indicators: { quote: [{ close: [10.5] }] },
            },
          ],
        },
      },
      "SNN.DE",
    );
    expect(s.points.map((p) => p.price)).toEqual([10.5, 11]);
  });

  it("throws on the provider's error and on an empty answer", () => {
    expect(() => parseChart({ chart: { result: null, error: { code: "Not Found", description: "No data found" } } }, "X")).toThrow(/Not Found/);
    expect(() => parseChart({ chart: { result: [] } }, "X")).toThrow(/empty/);
  });
});
