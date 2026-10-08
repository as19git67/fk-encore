import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createEodhdProvider,
  eodhdSecurityType,
  hostOf,
  parseEod,
  parseNews,
  parseRealTime,
  pickEodhdSymbol,
} from "./quote-provider-eodhd";
import { QuoteRateLimitedError } from "./quote-provider";
import { yahooSecurityType } from "./quote-provider-yahoo";

// Shapes as EODHD's endpoints answer them, with invented securities.
const ISIN = "XF00SONNE005";

afterEach(() => vi.unstubAllGlobals());

describe("security types", () => {
  it("reads EODHD's and Yahoo's type names", () => {
    expect(eodhdSecurityType("Common Stock")).toBe("equity");
    expect(eodhdSecurityType("Preferred Stock")).toBe("equity");
    expect(eodhdSecurityType("ETF")).toBe("etf");
    expect(eodhdSecurityType("FUND")).toBe("fund");
    expect(eodhdSecurityType("Mutual Fund")).toBe("fund");
    expect(eodhdSecurityType("BOND")).toBe("other");
    expect(eodhdSecurityType(undefined)).toBeNull();

    expect(yahooSecurityType("EQUITY")).toBe("equity");
    expect(yahooSecurityType("ETF")).toBe("etf");
    expect(yahooSecurityType("MUTUALFUND")).toBe("fund");
    expect(yahooSecurityType("INDEX")).toBe("other");
    expect(yahooSecurityType(undefined)).toBeNull();
  });
});

describe("pickEodhdSymbol", () => {
  it("takes the hit with this ISIN on a German venue", () => {
    const picked = pickEodhdSymbol(
      [
        { Code: "SNNX", Exchange: "US", Name: "Sonnenobst ADR", Type: "Common Stock", Currency: "USD", ISIN: "XF00OTHER001" },
        { Code: "SNN", Exchange: "F", Name: "Sonnenobst AG", Type: "Common Stock", Currency: "EUR", ISIN },
        { Code: "SNN", Exchange: "XETRA", Name: "Sonnenobst AG", Type: "Common Stock", Currency: "EUR", ISIN },
      ],
      ISIN,
    );
    expect(picked).toEqual({ symbol: "SNN.XETRA", name: "Sonnenobst AG", exchange: "XETRA", currency: "EUR", securityType: "equity" });
  });

  it("falls back to the first hit when none carries the ISIN, and to null for nothing", () => {
    expect(pickEodhdSymbol([{ Code: "SNN", Exchange: "LSE", Type: "ETF" }], ISIN)?.symbol).toBe("SNN.LSE");
    expect(pickEodhdSymbol([{ Name: "no code" }], ISIN)).toBeNull();
    expect(pickEodhdSymbol([], null)).toBeNull();
  });
});

describe("parsing", () => {
  it("dates an end-of-day bar at the close and skips bars without one", () => {
    const s = parseEod([{ date: "2026-02-03", close: 10.5 }, { date: "2026-02-04", close: null }, { date: "2026-02-05", close: 11 }], "SNN.XETRA", "EUR");
    expect(s.points).toEqual([
      { at: "2026-02-03T16:30:00.000Z", price: 10.5 },
      { at: "2026-02-05T16:30:00.000Z", price: 11 },
    ]);
  });

  it("reads the delayed real-time price and nothing when the market has none", () => {
    expect(parseRealTime({ timestamp: 1_770_000_000, close: 10.75 }, "SNN.XETRA", "EUR").points).toEqual([
      { at: "2026-02-02T02:40:00.000Z", price: 10.75 },
    ]);
    expect(parseRealTime({ timestamp: "NA", close: "NA" }, "SNN.XETRA", null).points).toEqual([]);
  });

  it("reads news, newest first, with source, a short summary and the polarity", () => {
    const long = "Wort ".repeat(200);
    const items = parseNews([
      { date: "2026-02-03T08:00:00+00:00", title: "Älter", link: "https://www.beispiel.test/a", content: "Kurz.", sentiment: { polarity: 0.4 } },
      { date: "2026-02-04T09:30:00+00:00", title: " Neuer ", link: "https://news.beispiel.test/b", content: long, sentiment: { polarity: 3 } },
      { date: "2026-02-04T10:00:00+00:00", title: "ohne Link" },
      { date: "kein Datum", title: "kaputt", link: "https://beispiel.test/c" },
    ]);
    expect(items.map((n) => n.title)).toEqual(["Neuer", "Älter"]);
    expect(items[0]).toMatchObject({ source: "news.beispiel.test", sentiment: 1 });
    expect(items[0]!.summary!.length).toBeLessThanOrEqual(601);
    expect(items[0]!.summary!.endsWith("…")).toBe(true);
    expect(items[1]).toMatchObject({ source: "beispiel.test", summary: "Kurz.", sentiment: 0.4, at: "2026-02-03T08:00:00.000Z" });
    expect(hostOf("kein link")).toBeNull();
  });
});

describe("createEodhdProvider", () => {
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

  it("resolves by ISIN, reads closes and news, with the token on every call", async () => {
    const urls = stub({
      "/api/search/": () => Response.json([{ Code: "SNN", Exchange: "XETRA", Name: "Sonnenobst AG", Type: "Common Stock", Currency: "EUR", ISIN }]),
      "/api/eod/": () => Response.json([{ date: "2026-02-03", close: 10.5 }]),
      "/api/news": () => Response.json([{ date: "2026-02-04T09:30:00+00:00", title: "Neu", link: "https://beispiel.test/n" }]),
    });
    const p = createEodhdProvider("test-token");
    expect(p.metering).toEqual({ resolve: 1, news: 5, dailyCalls: 20 });

    const sym = await p.resolve({ isin: ISIN, wkn: null, name: null });
    expect(sym?.symbol).toBe("SNN.XETRA");
    const series = await p.history("SNN.XETRA", "recent_days");
    expect(series).toMatchObject({ currency: "EUR", points: [{ price: 10.5 }] });
    const news = await p.news("SNN.XETRA", new Date("2026-02-01T00:00:00Z"));
    expect(news.map((n) => n.title)).toEqual(["Neu"]);

    expect(urls).toHaveLength(3);
    for (const u of urls) {
      expect(u).toContain("api_token=test-token");
      expect(u).toContain("fmt=json");
    }
    expect(urls[2]).toContain("s=SNN.XETRA");
    expect(urls[2]).toContain("from=2026-02-01");
  });

  it("asks nothing without an ISIN, reports an exhausted plan as a rate limit, and keeps the token out of errors", async () => {
    const urls = stub({
      "/api/real-time/": () => new Response("", { status: 402 }),
      "/api/eod/": () => new Response("", { status: 500 }),
    });
    const p = createEodhdProvider("secret-token", 100_000);
    expect(await p.resolve({ isin: null, wkn: "SNN001", name: null })).toBeNull();
    expect(urls).toHaveLength(0);

    await expect(p.history("SNN.XETRA", "intraday")).rejects.toBeInstanceOf(QuoteRateLimitedError);
    const err = await p.history("SNN.XETRA", "backfill").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("secret-token");
  });
});
