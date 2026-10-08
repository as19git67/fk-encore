/**
 * EODHD as a quote and news provider.
 *
 * A documented API with a token (secret `EodhdApiToken`). The free plan
 * allows 20 calls a day: a search, an end-of-day series or a real-time
 * price costs one, a news request five per symbol. That is enough for the
 * news of a few securities a day, not for quotes every five minutes — so
 * by default the quotes stay with Yahoo and EODHD brings the news. On a
 * paid plan it can serve the quotes too (`FINANCE_QUOTE_PROVIDER=eodhd`,
 * `FINANCE_EODHD_DAILY_CALLS` for the plan's allowance).
 *
 * Symbols are `CODE.EXCHANGE` ("ABC.XETRA"). Parsing is in pure functions
 * so the shapes can be tested without the network.
 */

import {
  QuoteRateLimitedError,
  type HistoryRange,
  type NewsItem,
  type NewsProvider,
  type QuoteProvider,
  type QuoteSeries,
  type QuoteSymbol,
  type SecurityType,
} from "./quote-provider";

const BASE_URL = "https://eodhd.com/api";
const TIMEOUT_MS = 15_000;

/** German venues first: Xetra, Frankfurt, then the regional exchanges. */
const EXCHANGE_PREFERENCE = ["XETRA", "F", "STU", "MU", "DU", "HM", "BE", "HA"];

/** What a call costs against the daily allowance. */
export const EODHD_COSTS = { resolve: 1, quote: 1, news: 5 } as const;
const DEFAULT_DAILY_CALLS = 20;

interface SearchHit {
  Code?: string;
  Exchange?: string;
  Name?: string;
  Type?: string;
  Currency?: string;
  ISIN?: string | null;
}

/** EODHD's type names as a security type. */
export function eodhdSecurityType(type: string | undefined): SecurityType | null {
  const t = (type ?? "").toLowerCase();
  if (!t) return null;
  if (t.includes("stock")) return "equity";
  if (t === "etf") return "etf";
  if (t.includes("fund")) return "fund";
  return "other";
}

/**
 * The best of the search's hits: exactly this ISIN when one is given, a
 * German listing first, else the first hit.
 */
export function pickEodhdSymbol(hits: SearchHit[], isin: string | null): QuoteSymbol | null {
  let usable = hits.filter((h) => h.Code && h.Exchange);
  if (isin) {
    const exact = usable.filter((h) => (h.ISIN ?? "").toUpperCase() === isin.toUpperCase());
    if (exact.length > 0) usable = exact;
  }
  if (usable.length === 0) return null;
  const rank = (h: SearchHit) => {
    const i = EXCHANGE_PREFERENCE.indexOf((h.Exchange ?? "").toUpperCase());
    return i === -1 ? EXCHANGE_PREFERENCE.length : i;
  };
  const h = [...usable].sort((a, b) => rank(a) - rank(b))[0]!;
  return {
    symbol: `${h.Code}.${h.Exchange}`,
    name: h.Name ?? null,
    exchange: h.Exchange ?? null,
    currency: h.Currency ?? null,
    securityType: eodhdSecurityType(h.Type),
  };
}

interface EodBar {
  date?: string;
  close?: number | null;
}

/** An end-of-day series; a bar is dated at the day's close (17:30 Berlin, here 16:30 UTC). */
export function parseEod(bars: EodBar[], symbol: string, currency: string | null): QuoteSeries {
  const points = [];
  for (const b of bars) {
    if (!b.date || b.close === null || b.close === undefined || !Number.isFinite(b.close)) continue;
    points.push({ at: `${b.date}T16:30:00.000Z`, price: b.close });
  }
  return { symbol, currency, points };
}

interface RealTime {
  timestamp?: number | string;
  close?: number | string;
}

/** The delayed real-time price as a one-point series; empty when the market has none. */
export function parseRealTime(body: RealTime, symbol: string, currency: string | null): QuoteSeries {
  const ts = typeof body.timestamp === "number" ? body.timestamp : Number(body.timestamp);
  const price = typeof body.close === "number" ? body.close : Number(body.close);
  if (!Number.isFinite(ts) || !Number.isFinite(price) || ts <= 0) return { symbol, currency, points: [] };
  return { symbol, currency, points: [{ at: new Date(ts * 1000).toISOString(), price }] };
}

interface NewsHit {
  date?: string;
  title?: string;
  content?: string;
  link?: string;
  sentiment?: { polarity?: number } | null;
}

const SUMMARY_LENGTH = 600;

/** The host of a link, without "www.", as the item's source. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** News items; ones without link, title or date are dropped. */
export function parseNews(hits: NewsHit[]): NewsItem[] {
  const items: NewsItem[] = [];
  for (const h of hits) {
    if (!h.link || !h.title || !h.date) continue;
    const at = new Date(h.date);
    if (Number.isNaN(at.getTime())) continue;
    const text = (h.content ?? "").replace(/\s+/g, " ").trim();
    const polarity = h.sentiment?.polarity;
    items.push({
      url: h.link,
      title: h.title.trim(),
      source: hostOf(h.link),
      at: at.toISOString(),
      summary: text ? (text.length > SUMMARY_LENGTH ? `${text.slice(0, SUMMARY_LENGTH).trimEnd()}…` : text) : null,
      sentiment: typeof polarity === "number" && Number.isFinite(polarity) ? Math.max(-1, Math.min(1, polarity)) : null,
    });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface EodhdProvider extends QuoteProvider, NewsProvider {
  readonly name: "eodhd";
}

/** The provider for a token; the allowance defaults to the free plan's. */
export function createEodhdProvider(token: string, dailyCalls = DEFAULT_DAILY_CALLS): EodhdProvider {
  async function get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const qs = new URLSearchParams({ ...params, api_token: token, fmt: "json" });
    const res = await fetch(`${BASE_URL}${path}?${qs.toString()}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    // 402: the plan's allowance is spent; 429: too many requests a minute.
    if (res.status === 429 || res.status === 402) throw new QuoteRateLimitedError(`eodhd ${res.status}`);
    // The token stays out of the message.
    if (!res.ok) throw new Error(`eodhd ${res.status} for ${path}`);
    return res.json();
  }

  /** The currency of a symbol, remembered from its search hit. */
  const currencies = new Map<string, string | null>();

  async function resolve(id: { isin: string | null; wkn: string | null; name: string | null }): Promise<QuoteSymbol | null> {
    // The ISIN finds the security exactly; EODHD's search does not know WKNs.
    if (!id.isin) return null;
    const hits = (await get(`/search/${encodeURIComponent(id.isin)}`, { limit: "20" })) as SearchHit[];
    const picked = pickEodhdSymbol(Array.isArray(hits) ? hits : [], id.isin);
    if (picked) currencies.set(picked.symbol, picked.currency);
    return picked;
  }

  return {
    name: "eodhd",
    metering: { resolve: EODHD_COSTS.resolve, news: EODHD_COSTS.news, dailyCalls },
    resolve,

    async history(symbol: string, range: HistoryRange): Promise<QuoteSeries> {
      const currency = currencies.get(symbol) ?? null;
      if (range === "intraday") {
        const body = (await get(`/real-time/${encodeURIComponent(symbol)}`)) as RealTime;
        return parseRealTime(body, symbol, currency);
      }
      const days = range === "backfill" ? 5 * 366 : 31;
      const from = isoDay(new Date(Date.now() - days * 24 * 60 * 60_000));
      const bars = (await get(`/eod/${encodeURIComponent(symbol)}`, { from, period: "d" })) as EodBar[];
      return parseEod(Array.isArray(bars) ? bars : [], symbol, currency);
    },

    async news(symbol: string, since: Date): Promise<NewsItem[]> {
      const hits = (await get("/news", { s: symbol, from: isoDay(since), limit: "50", offset: "0" })) as NewsHit[];
      return parseNews(Array.isArray(hits) ? hits : []).filter((n) => n.at >= since.toISOString());
    },
  };
}
