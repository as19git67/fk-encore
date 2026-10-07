import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cookieHeader, setYahooSession, yahooQuoteProvider } from "./quote-provider-yahoo";
import { QuoteRateLimitedError } from "./quote-provider";

/**
 * Yahoo refuses the search without its consent cookie and crumb. A fetch
 * that plays the site: the cookie page sets the cookie, getcrumb answers
 * with the crumb for it, the search answers only with both.
 */
function yahooLike(opts: { crumb?: string; refuseAll?: boolean } = {}) {
  const crumb = opts.crumb ?? "crumb-1";
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const h = new Headers(init?.headers);
    if (url.startsWith("https://fc.yahoo.com")) {
      return new Response("not found", { status: 404, headers: { "set-cookie": "A3=abc; Domain=.yahoo.com; Path=/; Secure" } });
    }
    if (url.includes("/v1/test/getcrumb")) {
      if (!h.get("cookie")?.includes("A3=abc")) return new Response("", { status: 401 });
      return new Response(crumb, { status: 200 });
    }
    if (opts.refuseAll) return new Response("Too Many Requests", { status: 429 });
    const u = new URL(url);
    if (u.searchParams.get("crumb") !== crumb || !h.get("cookie")?.includes("A3=abc")) {
      return new Response("Too Many Requests", { status: 429 });
    }
    if (url.includes("/v1/finance/search")) {
      return Response.json({ quotes: [{ symbol: "SNN.DE", exchange: "GER", longname: "Sonnenobst AG", quoteType: "EQUITY" }] });
    }
    return Response.json({
      chart: { result: [{ meta: { currency: "EUR" }, timestamp: [1_770_000_000], indicators: { quote: [{ close: [10.5] }] } }] },
    });
  });
  return { fetchMock, calls };
}

beforeEach(() => setYahooSession(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setYahooSession(null);
});

describe("cookieHeader", () => {
  it("keeps the name=value of each cookie and drops the attributes", () => {
    expect(cookieHeader(["A3=abc; Domain=.yahoo.com; Secure", "B=xyz; Path=/"])).toBe("A3=abc; B=xyz");
    expect(cookieHeader([])).toBe("");
  });
});

describe("yahoo session", () => {
  it("opens a session once and then searches and reads charts with it", async () => {
    const y = yahooLike();
    vi.stubGlobal("fetch", y.fetchMock);

    const found = await yahooQuoteProvider.resolve({ isin: "XF00SONNE005", wkn: null, name: null });
    expect(found?.symbol).toBe("SNN.DE");
    const series = await yahooQuoteProvider.history("SNN.DE", "intraday");
    expect(series.points).toHaveLength(1);

    // Cookie page, crumb, search, chart: the session was opened once.
    expect(y.calls.filter((u) => u.startsWith("https://fc.yahoo.com"))).toHaveLength(1);
    expect(y.calls.filter((u) => u.includes("getcrumb"))).toHaveLength(1);
  });

  it("renews a stale session once when refused, and reports a rate limit when that fails too", async () => {
    const y = yahooLike({ crumb: "crumb-2" });
    vi.stubGlobal("fetch", y.fetchMock);
    setYahooSession({ cookie: "A3=abc", crumb: "old", at: Date.now() });

    const found = await yahooQuoteProvider.resolve({ isin: "XF00SONNE005", wkn: null, name: null });
    expect(found?.symbol).toBe("SNN.DE");
    expect(y.calls.filter((u) => u.includes("getcrumb"))).toHaveLength(1);

    const refusing = yahooLike({ refuseAll: true });
    vi.stubGlobal("fetch", refusing.fetchMock);
    await expect(yahooQuoteProvider.history("SNN.DE", "intraday")).rejects.toBeInstanceOf(QuoteRateLimitedError);
  });
});
