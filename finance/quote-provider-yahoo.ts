/**
 * Yahoo Finance as a quote provider.
 *
 * Yahoo has no public API; what everybody uses are the JSON endpoints
 * behind its website. They cost nothing, know German exchanges and funds,
 * and are delayed by about fifteen minutes. They also change without
 * notice and answer 429 when asked too often. The service calls once per
 * security and tick, which has stayed well under that so far; a 429 ends
 * the tick and the next one waits for the backoff.
 *
 * Parsing is kept in pure functions so the shapes can be tested without
 * the network.
 */

import {
  QuoteRateLimitedError,
  type HistoryRange,
  type QuoteProvider,
  type QuoteSeries,
  type QuoteSymbol,
} from "./quote-provider";

const SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search";
const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
/** Yahoo refuses requests without a browser-like agent. */
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 15_000;

/**
 * German venues in the order a depot here prefers them: Xetra, then
 * Frankfurt (where Yahoo lists most funds), then the regional exchanges.
 */
const EXCHANGE_PREFERENCE = ["GER", "FRA", "STU", "MUN", "DUS", "HAM", "BER", "HAN"];

interface SearchQuote {
  symbol?: string;
  exchange?: string;
  exchDisp?: string;
  longname?: string;
  shortname?: string;
  quoteType?: string;
}

/** The best of the search's matches: a German listing first, else the first match. */
export function pickSymbol(quotes: SearchQuote[]): QuoteSymbol | null {
  const usable = quotes.filter((q) => q.symbol && q.quoteType !== "OPTION" && q.quoteType !== "FUTURE");
  if (usable.length === 0) return null;
  const ranked = [...usable].sort((a, b) => rank(a) - rank(b));
  const q = ranked[0]!;
  return {
    symbol: q.symbol!,
    name: q.longname ?? q.shortname ?? null,
    exchange: q.exchange ?? null,
    currency: null,
  };
}

function rank(q: SearchQuote): number {
  const i = EXCHANGE_PREFERENCE.indexOf(q.exchange ?? "");
  return i === -1 ? EXCHANGE_PREFERENCE.length : i;
}

interface ChartResponse {
  chart?: {
    result?: Array<{
      meta?: { currency?: string; symbol?: string; regularMarketPrice?: number; regularMarketTime?: number };
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }> | null;
    error?: { code?: string; description?: string } | null;
  };
}

/**
 * The series of a chart answer. Missing closes (a minute without a
 * trade) are skipped. The latest regular price is appended when it is
 * newer than the last bar, so a quote between bars is not lost.
 */
export function parseChart(body: ChartResponse, symbol: string): QuoteSeries {
  const err = body.chart?.error;
  if (err) throw new Error(`yahoo chart ${symbol}: ${err.code ?? "error"} ${err.description ?? ""}`.trim());
  const result = body.chart?.result?.[0];
  if (!result) throw new Error(`yahoo chart ${symbol}: empty answer`);
  const stamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const points = [];
  for (let i = 0; i < stamps.length; i++) {
    const price = closes[i];
    if (price === null || price === undefined || !Number.isFinite(price)) continue;
    points.push({ at: new Date(stamps[i]! * 1000).toISOString(), price });
  }
  const meta = result.meta;
  if (meta?.regularMarketPrice !== undefined && meta.regularMarketTime !== undefined) {
    const last = stamps[stamps.length - 1] ?? 0;
    if (meta.regularMarketTime > last && Number.isFinite(meta.regularMarketPrice)) {
      points.push({ at: new Date(meta.regularMarketTime * 1000).toISOString(), price: meta.regularMarketPrice });
    }
  }
  return { symbol, currency: meta?.currency ?? null, points };
}

const RANGE_PARAMS: Record<HistoryRange, string> = {
  intraday: "range=1d&interval=5m",
  recent_days: "range=1mo&interval=1d",
  backfill: "range=5y&interval=1d",
};

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429) throw new QuoteRateLimitedError();
  if (!res.ok) throw new Error(`yahoo ${res.status} for ${url}`);
  return res.json();
}

export const yahooQuoteProvider: QuoteProvider = {
  name: "yahoo",

  async resolve(id) {
    // The ISIN finds the security exactly; a WKN only sometimes. The name
    // is a last resort that may find a namesake, so it is not tried.
    for (const q of [id.isin, id.wkn]) {
      if (!q) continue;
      const url = `${SEARCH_URL}?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`;
      const body = (await getJson(url)) as { quotes?: SearchQuote[] };
      const picked = pickSymbol(body.quotes ?? []);
      if (picked) return picked;
    }
    return null;
  },

  async history(symbol, range) {
    const url = `${CHART_URL}/${encodeURIComponent(symbol)}?${RANGE_PARAMS[range]}&includePrePost=false`;
    const body = (await getJson(url)) as ChartResponse;
    return parseChart(body, symbol);
  },
};
