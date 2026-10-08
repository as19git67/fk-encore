import { describe, it, expect, afterEach, vi } from "vitest";
import {
  decodeSymbol,
  encodeSymbol,
  onvistaQuoteProvider,
  onvistaSecurityType,
  parseHistory,
  pickInstrument,
  pickNotation,
} from "./quote-provider-onvista";
import { QuoteRateLimitedError } from "./quote-provider";

// Shapes as Onvista's API answers them, with invented securities.
const ISIN = "XF00SONNE005";
const FUND_ISIN = "XF00MONDE003";

afterEach(() => vi.unstubAllGlobals());

describe("pickInstrument", () => {
  it("takes the hit with this ISIN or WKN among the types with prices", () => {
    const body = {
      facets: [
        { results: [{ entityType: "DERIVATIVE", entityValue: "1", isin: ISIN }] },
        { results: [{ entityType: "STOCK", entityValue: "77", isin: "XF00OTHER001", name: "Andere AG" }, { entityType: "STOCK", entityValue: "42", isin: ISIN, wkn: "SNN001", name: "Sonnenobst AG" }] },
      ],
    };
    expect(pickInstrument(body, { isin: ISIN, wkn: null })?.entityValue).toBe("42");
    expect(pickInstrument(body, { isin: null, wkn: "snn001" })?.entityValue).toBe("42");
    expect(pickInstrument({ list: [{ entityType: "FUND", entityValue: 9, isin: FUND_ISIN }] }, { isin: FUND_ISIN, wkn: null })?.entityValue).toBe(9);
  });

  it("answers null for an unrelated hit or nothing", () => {
    expect(pickInstrument({ list: [{ entityType: "STOCK", entityValue: "1", isin: "XF00OTHER001" }] }, { isin: ISIN, wkn: null })).toBeNull();
    expect(pickInstrument({}, { isin: ISIN, wkn: null })).toBeNull();
  });
});

describe("onvistaSecurityType", () => {
  it("tells shares, funds and ETFs apart", () => {
    expect(onvistaSecurityType({ entityType: "STOCK" })).toBe("equity");
    expect(onvistaSecurityType({ entityType: "FUND" })).toBe("fund");
    expect(onvistaSecurityType({ entityType: "FUND", instrumentType: "ETF" })).toBe("etf");
    expect(onvistaSecurityType({ entityType: "FUND", entityAttributes: ["ETF"] })).toBe("etf");
    expect(onvistaSecurityType({ entityType: "BOND" })).toBe("other");
  });
});

describe("pickNotation", () => {
  const list = [
    { market: { idNotation: 1, codeExchange: "FRA", name: "Frankfurt" }, last: 10.4 },
    { market: { idNotation: 2, codeExchange: "GER", name: "Xetra" }, last: 10.5 },
    { market: { idNotation: 3, codeExchange: "KAG", name: "Fondsgesellschaft" }, last: 10.3 },
    { market: { idNotation: 4, codeExchange: "GAT", name: "Tradegate" } },
  ];

  it("prefers Xetra for a share and the fund company's price for a fund", () => {
    expect(pickNotation({ quoteList: { list } }, false)?.market?.idNotation).toBe(2);
    expect(pickNotation({ quoteList: { list } }, true)?.market?.idNotation).toBe(3);
  });

  it("skips a venue without a price and falls back to the snapshot's own quote", () => {
    const onlyUnpriced = [{ market: { idNotation: 4, codeExchange: "GAT" } }, { market: { idNotation: 5, codeExchange: "XYZ" }, last: 9 }];
    expect(pickNotation({ quote: { market: { idNotation: 7 } }, quoteList: { list: onlyUnpriced } }, false)?.market?.idNotation).toBe(7);
    expect(pickNotation({ quoteList: { list: onlyUnpriced } }, false)?.market?.idNotation).toBe(5);
    expect(pickNotation({}, false)).toBeNull();
  });
});

describe("symbols and history", () => {
  it("encodes type, entity and notation, and refuses anything else", () => {
    expect(decodeSymbol(encodeSymbol("STOCK", "42", 2))).toEqual({ type: "STOCK", entityValue: "42", idNotation: "2" });
    expect(decodeSymbol("SNN.DE")).toBeNull();
  });

  it("reads parallel arrays of times (seconds or ISO) and prices, skipping gaps", () => {
    const s = parseHistory(
      { datetimeLast: [1_770_000_000, "2026-02-03T16:30:00Z", 1_770_100_000], last: [10.5, 10.6, null], isoCurrency: "EUR" },
      "STOCK:42:2",
      null,
    );
    expect(s.currency).toBe("EUR");
    expect(s.points).toEqual([
      { at: "2026-02-02T02:40:00.000Z", price: 10.5 },
      { at: "2026-02-03T16:30:00.000Z", price: 10.6 },
    ]);
    expect(parseHistory({}, "STOCK:42:2", "EUR")).toEqual({ symbol: "STOCK:42:2", currency: "EUR", points: [] });
  });
});

describe("onvistaQuoteProvider", () => {
  function stub(answers: Record<string, () => Response>) {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        const key = Object.keys(answers).find((k) => url.includes(k));
        return key ? answers[key]!() : new Response("not found", { status: 404 });
      }),
    );
    return urls;
  }

  it("resolves by search and snapshot, then reads closes and the day from the chosen notation", async () => {
    const urls = stub({
      "/instruments/search/facet": () =>
        Response.json({ facets: [{ results: [{ entityType: "STOCK", entityValue: "42", isin: ISIN, name: "Sonnenobst AG" }] }] }),
      "/stocks/ISIN:": () =>
        Response.json({ quoteList: { list: [{ market: { idNotation: 2, codeExchange: "GER", name: "Xetra" }, last: 10.5, isoCurrency: "EUR" }] } }),
      "/eod_history": () => Response.json({ datetimeLast: [1_770_000_000], last: [10.5] }),
      "/chart_history": () => Response.json({ datetimeLast: [1_770_000_300], last: [10.55] }),
    });

    const sym = await onvistaQuoteProvider.resolve({ isin: ISIN, wkn: null, name: null });
    expect(sym).toEqual({ symbol: "STOCK:42:2", name: "Sonnenobst AG", exchange: "Xetra", currency: "EUR", securityType: "equity" });

    const closes = await onvistaQuoteProvider.history("STOCK:42:2", "backfill");
    expect(closes).toMatchObject({ currency: "EUR", points: [{ price: 10.5 }] });
    const day = await onvistaQuoteProvider.history("STOCK:42:2", "intraday");
    expect(day.points.map((p) => p.price)).toEqual([10.55]);

    expect(urls[0]).toContain(`searchValue=${ISIN}`);
    expect(urls[1]).toContain(`/stocks/ISIN:${ISIN}/snapshot`);
    expect(urls[2]).toMatch(/\/instruments\/STOCK\/42\/eod_history\?idNotation=2&range=Y5&startDate=\d{4}-\d{2}-\d{2}/);
    expect(urls[3]).toMatch(/\/instruments\/STOCK\/42\/chart_history\?idNotation=2&resolution=5m/);
  });

  it("answers null for an unknown security and reports a 429 as a rate limit", async () => {
    stub({
      "/instruments/search/facet": () => Response.json({ facets: [] }),
      "/eod_history": () => new Response("", { status: 429 }),
    });
    expect(await onvistaQuoteProvider.resolve({ isin: ISIN, wkn: null, name: null })).toBeNull();
    expect(await onvistaQuoteProvider.resolve({ isin: null, wkn: null, name: "nur Name" })).toBeNull();
    await expect(onvistaQuoteProvider.history("STOCK:42:2", "recent_days")).rejects.toBeInstanceOf(QuoteRateLimitedError);
    await expect(onvistaQuoteProvider.history("SNN.DE", "recent_days")).rejects.toThrow(/not a symbol/);
  });
});
