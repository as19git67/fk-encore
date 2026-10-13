import { afterEach, describe, expect, it, vi } from "vitest";

import { QuoteRateLimitedError } from "./quote-provider";
import {
  createYahooNewsProvider,
  normalizeNewsUrl,
  parseYahooRss,
  rssText,
  yahooSymbolFromKnown,
} from "./quote-provider-yahoo-news";

// A recorded shape with invented content: tickers, hosts and titles are made up.
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Yahoo! Finance: SNN.DE News</title>
    <item>
      <description><![CDATA[Die <b>Sonnenwerk AG</b> hebt die Prognose an &amp; erhöht die Dividende.]]></description>
      <guid isPermaLink="false">beispiel-1</guid>
      <link>https://finance.yahoo.com/news/sonnenwerk-prognose-100000001.html?.tsrc=rss</link>
      <pubDate>Tue, 03 Feb 2026 08:15:00 +0000</pubDate>
      <title>Sonnenwerk &quot;hebt&quot; Prognose an</title>
    </item>
    <item>
      <title>Sonnenwerk: Neuer Vorstand</title>
      <link>https://www.beispiel-nachrichten.test/artikel/42</link>
      <pubDate>Wed, 04 Feb 2026 09:30:00 +0100</pubDate>
    </item>
    <item>
      <title>Ohne Datum</title>
      <link>https://beispiel-nachrichten.test/ohne-datum</link>
    </item>
    <item>
      <title>Kein Link</title>
      <link>javascript:alert(1)</link>
      <pubDate>Wed, 04 Feb 2026 09:30:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;

describe("parseYahooRss", () => {
  it("reads the items newest first, without the tracking parameter, and skips incomplete ones", () => {
    const items = parseYahooRss(FEED);
    expect(items).toEqual([
      {
        url: "https://www.beispiel-nachrichten.test/artikel/42",
        title: "Sonnenwerk: Neuer Vorstand",
        source: "beispiel-nachrichten.test",
        at: "2026-02-04T08:30:00.000Z",
        summary: null,
        sentiment: null,
      },
      {
        url: "https://finance.yahoo.com/news/sonnenwerk-prognose-100000001.html",
        title: 'Sonnenwerk "hebt" Prognose an',
        source: "finance.yahoo.com",
        at: "2026-02-03T08:15:00.000Z",
        summary: "Die Sonnenwerk AG hebt die Prognose an & erhöht die Dividende.",
        sentiment: null,
      },
    ]);
  });

  it("reads an empty feed as no items", () => {
    expect(parseYahooRss("<rss><channel><title>leer</title></channel></rss>")).toEqual([]);
  });
});

describe("rssText and normalizeNewsUrl", () => {
  it("decodes entities and numeric references", () => {
    expect(rssText("A &#38; B &#x2013; C&nbsp;D")).toBe("A & B – C D");
  });

  it("keeps the other query parameters and refuses what is no web link", () => {
    expect(normalizeNewsUrl("https://beispiel.test/a?id=7&.tsrc=rss#top")).toBe("https://beispiel.test/a?id=7");
    expect(normalizeNewsUrl("ftp://beispiel.test/a")).toBeNull();
    expect(normalizeNewsUrl("kein link")).toBeNull();
  });
});

describe("yahooSymbolFromKnown", () => {
  it("takes Yahoo's own quote symbol first", () => {
    expect(yahooSymbolFromKnown([{ provider: "eodhd", symbol: "SNN.XETRA" }, { provider: "yahoo", symbol: "SNN.F" }])).toBe("SNN.F");
  });

  it("translates an EODHD exchange into Yahoo's suffix", () => {
    expect(yahooSymbolFromKnown([{ provider: "eodhd", symbol: "SNN.XETRA" }])).toBe("SNN.DE");
    expect(yahooSymbolFromKnown([{ provider: "eodhd", symbol: "MND.US" }])).toBe("MND");
    expect(yahooSymbolFromKnown([{ provider: "eodhd", symbol: "STR.LSE" }])).toBe("STR.L");
  });

  it("knows nothing from Onvista's notation ids or an unknown exchange", () => {
    expect(yahooSymbolFromKnown([{ provider: "onvista", symbol: "STOCK:123:456" }])).toBeNull();
    expect(yahooSymbolFromKnown([{ provider: "eodhd", symbol: "SNN.XX" }])).toBeNull();
    expect(yahooSymbolFromKnown([])).toBeNull();
  });
});

describe("createYahooNewsProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks the feed for the symbol and keeps the items since the given time", async () => {
    const fetchMock = vi.fn(async () => new Response(FEED, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createYahooNewsProvider();
    expect(provider.metering).toBeNull();

    const items = await provider.news("SNN.DE", new Date("2026-02-04T00:00:00Z"));
    expect(items.map((n) => n.title)).toEqual(["Sonnenwerk: Neuer Vorstand"]);
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("feeds.finance.yahoo.com/rss/2.0/headline?s=SNN.DE");
  });

  it("reports a refusal as a rate limit and other failures as errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    await expect(createYahooNewsProvider().news("SNN.DE", new Date(0))).rejects.toBeInstanceOf(QuoteRateLimitedError);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(createYahooNewsProvider().news("SNN.DE", new Date(0))).rejects.toThrow(/404/);
  });
});
