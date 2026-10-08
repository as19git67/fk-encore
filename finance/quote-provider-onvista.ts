/**
 * Onvista as a quote provider.
 *
 * Onvista's website reads its prices from a JSON API under
 * api.onvista.de/api/v1. It is not documented, but it needs no token,
 * knows German exchanges and funds (the fund company's own price too), and
 * finds a security by ISIN or WKN. Yahoo answers requests that do not look
 * like a browser with 429 whatever the rate; Onvista has not so far.
 *
 * A security is found in three steps: the search gives its type and
 * Onvista's id, the snapshot lists its quotes per exchange ("notations"),
 * and the history of one notation gives the prices. The provider's symbol
 * carries all three: `TYPE:entityValue:idNotation`.
 *
 * Parsing is in pure functions so the shapes can be tested without the
 * network.
 */

import {
  QuoteRateLimitedError,
  type HistoryRange,
  type QuoteProvider,
  type QuoteSeries,
  type QuoteSymbol,
} from "./quote-provider";

/** What kind of security an instrument is; decides which venue's price counts. */
export type OnvistaKind = "equity" | "etf" | "fund" | "other";

const BASE_URL = "https://api.onvista.de/api/v1";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 15_000;

/** Onvista's entity types with a snapshot, and the path segment it lives under. */
const SNAPSHOT_PATH: Record<string, string> = { STOCK: "stocks", FUND: "funds", BOND: "bonds" };

/**
 * Venues in the order a German depot prefers them: Xetra, Tradegate,
 * Frankfurt, then the regional exchanges. A fund's own price (the fund
 * company, "KAG") comes first for funds: it is the price the depot values.
 */
const EXCHANGE_PREFERENCE = ["GER", "GAT", "FRA", "STU", "MUN", "DUS", "HAM", "BER", "HAN", "LSX", "QUO"];
const FUND_PREFERENCE = ["KAG", ...EXCHANGE_PREFERENCE];

interface OnvistaInstrument {
  entityType?: string;
  entityValue?: string | number;
  name?: string;
  isin?: string;
  wkn?: string;
  instrumentType?: string;
  entityAttributes?: string[];
}

interface SearchBody {
  list?: OnvistaInstrument[];
  facets?: Array<{ results?: OnvistaInstrument[] }>;
}

/** The search's hit for this ISIN or WKN among the types with prices. */
export function pickInstrument(body: SearchBody, id: { isin: string | null; wkn: string | null }): OnvistaInstrument | null {
  const all = [...(body.list ?? []), ...(body.facets ?? []).flatMap((f) => f.results ?? [])];
  const usable = all.filter((i) => i.entityType && SNAPSHOT_PATH[i.entityType] && i.entityValue !== undefined);
  const exact = usable.find(
    (i) =>
      (id.isin && (i.isin ?? "").toUpperCase() === id.isin.toUpperCase()) ||
      (id.wkn && (i.wkn ?? "").toUpperCase() === id.wkn.toUpperCase()),
  );
  return exact ?? null;
}

/** Onvista's types as a security type; an ETF is a fund whose type or attributes say so. */
export function onvistaSecurityType(i: OnvistaInstrument): OnvistaKind {
  if (i.entityType === "STOCK") return "equity";
  if (i.entityType === "FUND") {
    const marks = [i.instrumentType ?? "", ...(i.entityAttributes ?? [])].join(" ").toUpperCase();
    return marks.includes("ETF") ? "etf" : "fund";
  }
  return "other";
}

interface Notation {
  idNotation?: number | string;
  name?: string;
  codeExchange?: string;
}

interface SnapshotQuote {
  market?: Notation;
  last?: number;
  datetimeLast?: string | number;
  isoCurrency?: string;
  volume?: number;
}

interface SnapshotBody {
  quote?: SnapshotQuote;
  quoteList?: { list?: SnapshotQuote[] };
}

/**
 * The notation to read prices from: the preferred venue that has a price,
 * else the snapshot's own default, else the first with a price.
 */
export function pickNotation(body: SnapshotBody, fund: boolean): SnapshotQuote | null {
  const quotes = (body.quoteList?.list ?? []).filter((q) => q.market?.idNotation !== undefined);
  const priced = quotes.filter((q) => typeof q.last === "number" && Number.isFinite(q.last));
  for (const code of fund ? FUND_PREFERENCE : EXCHANGE_PREFERENCE) {
    const q = priced.find((x) => (x.market?.codeExchange ?? "").toUpperCase() === code);
    if (q) return q;
  }
  if (body.quote?.market?.idNotation !== undefined) return body.quote;
  return priced[0] ?? quotes[0] ?? null;
}

/** `TYPE:entityValue:idNotation` and back. */
export function encodeSymbol(type: string, entityValue: string | number, idNotation: string | number): string {
  return `${type}:${entityValue}:${idNotation}`;
}

export function decodeSymbol(symbol: string): { type: string; entityValue: string; idNotation: string } | null {
  const [type, entityValue, idNotation] = symbol.split(":");
  if (!type || !entityValue || !idNotation) return null;
  return { type, entityValue, idNotation };
}

/** A timestamp in seconds, milliseconds or ISO form as ISO. */
function toIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

interface HistoryBody {
  datetimeLast?: Array<number | string>;
  last?: Array<number | null>;
  isoCurrency?: string;
}

/** A history answer (eod_history, chart_history): parallel arrays of times and prices. */
export function parseHistory(body: HistoryBody, symbol: string, currency: string | null): QuoteSeries {
  const times = body.datetimeLast ?? [];
  const prices = body.last ?? [];
  const points = [];
  for (let i = 0; i < times.length; i++) {
    const at = toIso(times[i]);
    const price = prices[i];
    if (!at || price === null || price === undefined || !Number.isFinite(price)) continue;
    points.push({ at, price });
  }
  return { symbol, currency: body.isoCurrency ?? currency, points };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429) throw new QuoteRateLimitedError("onvista 429");
  if (!res.ok) throw new Error(`onvista ${res.status} for ${path}`);
  return res.json();
}

/** The currency per symbol, from the snapshot; history answers may lack it. */
const currencies = new Map<string, string | null>();

export const onvistaQuoteProvider: QuoteProvider = {
  name: "onvista",

  async resolve(id): Promise<QuoteSymbol | null> {
    const key = id.isin ?? id.wkn;
    if (!key) return null;
    const search = (await getJson(`/instruments/search/facet?perType=10&searchValue=${encodeURIComponent(key)}`)) as SearchBody;
    const instrument = pickInstrument(search, id);
    if (!instrument?.isin || !instrument.entityType) return null;
    const path = SNAPSHOT_PATH[instrument.entityType]!;
    const snapshot = (await getJson(`/${path}/ISIN:${encodeURIComponent(instrument.isin)}/snapshot`)) as SnapshotBody;
    const type = onvistaSecurityType(instrument);
    const notation = pickNotation(snapshot, type === "fund" || type === "etf");
    if (!notation?.market?.idNotation) return null;
    const symbol = encodeSymbol(instrument.entityType, instrument.entityValue!, notation.market.idNotation);
    const currency = notation.isoCurrency ?? null;
    currencies.set(symbol, currency);
    return {
      symbol,
      name: instrument.name ?? null,
      exchange: notation.market.name ?? notation.market.codeExchange ?? null,
      currency,
    };
  },

  async history(symbol: string, range: HistoryRange): Promise<QuoteSeries> {
    const s = decodeSymbol(symbol);
    if (!s) throw new Error(`onvista: not a symbol of this provider: ${symbol}`);
    const base = `/instruments/${encodeURIComponent(s.type)}/${encodeURIComponent(s.entityValue)}`;
    const now = new Date();
    const day = 24 * 60 * 60_000;
    const currency = currencies.get(symbol) ?? null;
    if (range === "intraday") {
      const qs = `idNotation=${s.idNotation}&resolution=5m&startDate=${isoDay(new Date(now.getTime() - day))}&endDate=${isoDay(new Date(now.getTime() + day))}`;
      return parseHistory((await getJson(`${base}/chart_history?${qs}`)) as HistoryBody, symbol, currency);
    }
    const [r, days] = range === "backfill" ? ["Y5", 5 * 366] : ["M1", 31];
    const qs = `idNotation=${s.idNotation}&range=${r}&startDate=${isoDay(new Date(now.getTime() - days * day))}`;
    return parseHistory((await getJson(`${base}/eod_history?${qs}`)) as HistoryBody, symbol, currency);
  },
};
