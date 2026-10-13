/**
 * Yahoo's RSS feed as a news provider: free, unmetered, no consent cookie.
 *
 * The feed (`feeds.finance.yahoo.com/rss/2.0/headline?s=SYMBOL`) lists the
 * latest headlines about one Yahoo symbol. Its coverage of German
 * securities is thin, so it complements EODHD rather than replacing it.
 *
 * The symbol is worked out from what other providers already know (an
 * EODHD symbol "ABC.XETRA" is Yahoo's "ABC.DE"); only when none of them
 * translates is Yahoo's search asked, which wants the consent session and
 * may refuse a server.
 *
 * Parsing is kept in pure functions so the shapes can be tested without
 * the network.
 */

import { QuoteRateLimitedError, type NewsItem, type NewsProvider } from "./quote-provider";
import { yahooQuoteProvider } from "./quote-provider-yahoo";

const FEED_URL = "https://feeds.finance.yahoo.com/rss/2.0/headline";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 15_000;

/** EODHD's exchange codes and the suffix Yahoo gives the same listing. */
const EODHD_TO_YAHOO: Record<string, string> = {
  XETRA: ".DE",
  F: ".F",
  STU: ".SG",
  MU: ".MU",
  DU: ".DU",
  HM: ".HM",
  BE: ".BE",
  HA: ".HA",
  US: "",
  LSE: ".L",
  PA: ".PA",
  AS: ".AS",
  SW: ".SW",
  MI: ".MI",
  MC: ".MC",
  VI: ".VI",
  TO: ".TO",
};

/**
 * Yahoo's symbol from symbols other providers know: Yahoo's own quote
 * symbol as it is, else an EODHD symbol whose exchange has a Yahoo
 * suffix. Null when none translates (Onvista's notation ids do not).
 */
export function yahooSymbolFromKnown(known: Array<{ provider: string; symbol: string }>): string | null {
  const own = known.find((k) => k.provider === "yahoo" && k.symbol);
  if (own) return own.symbol;
  for (const k of known) {
    if (k.provider !== "eodhd") continue;
    const dot = k.symbol.lastIndexOf(".");
    if (dot <= 0) continue;
    const suffix = EODHD_TO_YAHOO[k.symbol.slice(dot + 1).toUpperCase()];
    if (suffix === undefined) continue;
    return `${k.symbol.slice(0, dot)}${suffix}`;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The text of an element: CDATA unwrapped, entities decoded, markup dropped. */
export function rssText(raw: string): string {
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const decoded = unwrapped.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  // A description may carry markup of its own once decoded.
  return decoded.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function element(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? rssText(m[1]!) : null;
}

/**
 * The article's URL without the feed's tracking parameter (".tsrc=rss"),
 * so the same article reached another way is stored once.
 */
export function normalizeNewsUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.searchParams.delete(".tsrc");
  url.hash = "";
  return url.toString();
}

/** The items of a feed, newest first. Items without link, title or date are skipped. */
export function parseYahooRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const block = m[1]!;
    const title = element(block, "title");
    const link = element(block, "link");
    const date = element(block, "pubDate");
    if (!title || !link || !date) continue;
    const url = normalizeNewsUrl(link);
    const at = Date.parse(date);
    if (!url || !Number.isFinite(at)) continue;
    const summary = element(block, "description");
    items.push({
      url,
      title,
      source: new URL(url).hostname.replace(/^www\./, ""),
      at: new Date(at).toISOString(),
      summary: summary || null,
      sentiment: null,
    });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

export function createYahooNewsProvider(): NewsProvider {
  return {
    name: "yahoo",
    metering: null,
    // Unmetered, but one feed after another without a break invites a 429.
    pauseMs: 1500,
    symbolFromKnown: yahooSymbolFromKnown,
    resolve: (id) => yahooQuoteProvider.resolve(id),
    async news(symbol, since) {
      const url = `${FEED_URL}?s=${encodeURIComponent(symbol)}&region=DE&lang=de-DE`;
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429) throw new QuoteRateLimitedError("yahoo news rate limit");
      if (!res.ok) throw new Error(`yahoo news ${res.status} for ${symbol}`);
      const sinceIso = since.toISOString();
      return parseYahooRss(await res.text()).filter((n) => n.at >= sinceIso);
    },
  };
}
