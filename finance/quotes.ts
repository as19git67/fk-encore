/**
 * Prices of the securities the depots hold.
 *
 * The bank's holdings snapshot carries yesterday's price at best. For a
 * current one the quote provider (`quote-provider.ts`) is asked for every
 * security with a position, and what it answers is kept in
 * `finance_quote`: the day's minutes while the markets are open, the
 * closes for good. The history is therefore ours, whatever the provider
 * does tomorrow.
 *
 * `refreshQuotes` (`quote-refresh.ts`) is the one writer; the scheduler
 * (`quotes-cron.ts`) and the refresh endpoint both call it. `getQuotes`
 * reads for the page.
 */

import { api, APIError } from "encore.dev/api";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import db from "../db/database";
import { financeNewsSeen, financeQuote, financeQuoteNews, financeQuoteSymbol } from "../db/schema";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { compareDepotThenName, firstDepotLabel, latestHoldings, visibleDepots } from "./portfolio";
import { isoTimestamp, latestQuotes } from "./quote-store";
import { refreshQuotes, type ActivePosition, type RefreshStats } from "./quote-refresh";

console.log("[boot] finance/quotes.ts: all imports resolved");

export { refreshQuotes, type ActivePosition, type RefreshStats } from "./quote-refresh";

/**
 * The securities with shares in the latest snapshot of any of the
 * depots. One entry per security, however many depots hold it. A
 * holding without ISIN and WKN has nothing a provider could look up.
 */
export async function activePositions(accountIds: number[]): Promise<ActivePosition[]> {
  const byKey = new Map<string, ActivePosition>();
  for (const h of await latestHoldings(accountIds)) {
    const key = h.isin || h.wkn;
    if (!key) continue;
    const amount = Number(h.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const p = byKey.get(key) ?? { key, isin: h.isin, wkn: h.wkn, name: h.name, amount: 0, account_ids: [] };
    p.amount += amount;
    if (!p.account_ids.includes(h.account_id)) p.account_ids.push(h.account_id);
    p.isin ??= h.isin;
    p.wkn ??= h.wkn;
    p.name ??= h.name;
    byKey.set(key, p);
  }
  return [...byKey.values()];
}

const iso = isoTimestamp;

// ----------------------------------------------------------------------
// Reading
// ----------------------------------------------------------------------

export type QuoteRange = "1d" | "1w" | "1m" | "1y" | "max";
const RANGES: readonly QuoteRange[] = ["1d", "1w", "1m", "1y", "max"];

/** Where a range starts, and whether it is drawn from the minutes or the closes. */
export function rangeWindow(range: QuoteRange, now: Date): { from: string | null; kind: "intraday" | "daily" } {
  const day = 24 * 60 * 60_000;
  switch (range) {
    case "1d": return { from: new Date(now.getTime() - 1 * day).toISOString(), kind: "intraday" };
    case "1w": return { from: new Date(now.getTime() - 7 * day).toISOString(), kind: "intraday" };
    case "1m": return { from: new Date(now.getTime() - 31 * day).toISOString(), kind: "daily" };
    case "1y": return { from: new Date(now.getTime() - 366 * day).toISOString(), kind: "daily" };
    case "max": return { from: null, kind: "daily" };
  }
}

/** At most this many points per series go to the page. */
const MAX_POINTS = 300;

/** Every n-th point, the last one always included. */
export function thin<T>(points: T[], max = MAX_POINTS): T[] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out = points.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]!);
  return out;
}

export interface QuoteTile {
  key: string;
  /** The depot the tile is listed under: the first of the depots holding it, by label. */
  depot: string;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  /** Shares across the depots in scope (scale 8). */
  amount: string;
  currency: string | null;
  /** The newest price known, whatever the range. */
  last: { at: string; price: string } | null;
  /** Value of the shares at the last price (scale 2). */
  value: string | null;
  /** Change over the range: last against the first point in it. */
  change: { absolute: string; percent: string } | null;
  points: { at: string; price: string }[];
  /** Why there is nothing: no symbol found, or no prices yet. */
  status: "ok" | "unresolved" | "pending";
  /** News that came in since the caller last opened the position's news. */
  news_unread: number;
}

interface QuotesParams {
  range?: string;
  /** Comma-separated depot account ids; omitted = every open readable depot. */
  accounts?: string;
}

interface QuotesResponse {
  range: QuoteRange;
  tiles: QuoteTile[];
  /** When the newest price in the answer was fetched. */
  as_of: string | null;
}

function parseAccountIds(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const ids = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : null;
}

/** News not seen before a user has never opened a position count from this far back. */
const UNREAD_NEWS_DAYS = 7;

/**
 * Per position, the news newer than the user last looked at them — or,
 * never looked, than a week ago, so a first visit does not show months.
 */
export async function unreadNewsCounts(userId: number | null, keys: string[], now: Date): Promise<Map<string, number>> {
  if (userId === null || keys.length === 0) return new Map();
  const floor = new Date(now.getTime() - UNREAD_NEWS_DAYS * 24 * 60 * 60_000).toISOString();
  const rows = await db
    .select({ key: financeQuoteNews.position_key, n: sql<number>`COUNT(*)::int` })
    .from(financeQuoteNews)
    .leftJoin(
      financeNewsSeen,
      and(eq(financeNewsSeen.position_key, financeQuoteNews.position_key), eq(financeNewsSeen.user_id, userId)),
    )
    .where(
      and(
        inArray(financeQuoteNews.position_key, keys),
        sql`${financeQuoteNews.at} > COALESCE(${financeNewsSeen.seen_at}, ${floor}::timestamptz)`,
      ),
    )
    .groupBy(financeQuoteNews.position_key);
  return new Map(rows.map((r) => [r.key, Number(r.n)]));
}

export async function buildQuoteTiles(
  accountIds: number[],
  range: QuoteRange,
  now = new Date(),
  userId: number | null = null,
  /** Depot labels by id: the tiles are listed by depot, then name, as in the portfolio. */
  depotLabels: ReadonlyMap<number, string> = new Map(),
): Promise<QuoteTile[]> {
  const positions = await activePositions(accountIds);
  if (positions.length === 0) return [];
  const keys = positions.map((p) => p.key);
  const symbols = new Map(
    (await db.select().from(financeQuoteSymbol).where(inArray(financeQuoteSymbol.position_key, keys))).map((r) => [r.position_key, r]),
  );
  const { from, kind } = rangeWindow(range, now);
  const columns = { key: financeQuote.position_key, at: financeQuote.at, price: financeQuote.price, currency: financeQuote.currency, kind: financeQuote.kind };
  const conditions = [inArray(financeQuote.position_key, keys)];
  // A day or a week reads the closes too: the minutes are kept only from
  // the day the quotes started, and on a closed market there are none.
  if (kind === "daily") conditions.push(eq(financeQuote.kind, "daily"));
  if (from) conditions.push(gte(financeQuote.at, from));
  const rows = await db.select(columns).from(financeQuote).where(and(...conditions)).orderBy(asc(financeQuote.at));
  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byKey.get(r.key) ?? [];
    list.push(r);
    byKey.set(r.key, list);
  }
  if (kind === "intraday") {
    // The closes fill the window up to the first minute; without a close in
    // the window the one before it is the start, so the change is measured
    // against the last close.
    const before = from
      ? await db
          .selectDistinctOn([financeQuote.position_key], columns)
          .from(financeQuote)
          .where(and(inArray(financeQuote.position_key, keys), eq(financeQuote.kind, "daily"), lt(financeQuote.at, from)))
          .orderBy(financeQuote.position_key, sql`${financeQuote.at} DESC`)
      : [];
    const beforeByKey = new Map(before.map((r) => [r.key, r]));
    for (const key of keys) {
      const list = byKey.get(key) ?? [];
      const firstMinute = list.find((r) => r.kind === "intraday");
      const closes = list.filter((r) => r.kind === "daily" && (!firstMinute || Date.parse(r.at) < Date.parse(firstMinute.at)));
      const start = closes.length === 0 ? beforeByKey.get(key) : undefined;
      const merged = [...(start ? [start] : []), ...closes, ...list.filter((r) => r.kind === "intraday")];
      if (merged.length > 0) byKey.set(key, merged);
    }
  }
  // The newest price of each security, from either kind — a day's range
  // on a closed market would otherwise show nothing.
  const lastByKey = await latestQuotes(keys);
  const unread = await unreadNewsCounts(userId, keys, now);

  return positions
    .map((p): QuoteTile => {
      const sym = symbols.get(p.key);
      const series = byKey.get(p.key) ?? [];
      const last = lastByKey.get(p.key) ?? null;
      const name = sym?.name ?? p.name;
      const currency = last?.currency ?? sym?.currency ?? null;
      const status: QuoteTile["status"] = !sym || !sym.symbol ? (sym?.failed_at ? "unresolved" : "pending") : last ? "ok" : "pending";
      const first = series[0] ?? null;
      const change =
        first && last && Number(first.price) !== 0
          ? {
              absolute: (Number(last.price) - Number(first.price)).toFixed(2),
              percent: (((Number(last.price) - Number(first.price)) / Number(first.price)) * 100).toFixed(2),
            }
          : null;
      // The closes end yesterday; the newest price finishes the line.
      const drawn = thin(series).map((r) => ({ at: iso(r.at), price: Number(r.price).toFixed(6) }));
      if (last && (drawn.length === 0 || last.at > drawn[drawn.length - 1]!.at)) {
        drawn.push({ at: last.at, price: last.price.toFixed(6) });
      }
      return {
        key: p.key,
        depot: firstDepotLabel(p.account_ids, depotLabels),
        isin: p.isin,
        wkn: p.wkn,
        name,
        amount: p.amount.toFixed(8),
        currency,
        last: last ? { at: last.at, price: last.price.toFixed(6) } : null,
        value: last ? (p.amount * last.price).toFixed(2) : null,
        change,
        points: drawn,
        status,
        news_unread: unread.get(p.key) ?? 0,
      };
    })
    .sort((a, b) => compareDepotThenName({ depot: a.depot, name: a.name ?? a.key }, { depot: b.depot, name: b.name ?? b.key }));
}

export const getQuotes = api(
  { expose: true, method: "GET", path: "/finance/quotes", auth: true },
  async ({ range, accounts }: QuotesParams): Promise<QuotesResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const r = (range ?? "1m") as QuoteRange;
    if (!RANGES.includes(r)) throw APIError.invalidArgument(`range must be one of ${RANGES.join(", ")}`);
    const depots = (await visibleDepots(auth, parseAccountIds(accounts))).filter((d) => !d.closed || accounts);
    const labels = new Map(depots.map((d) => [d.id, d.label]));
    const tiles = await buildQuoteTiles(depots.map((d) => d.id), r, new Date(), Number(auth.userID), labels);
    const asOf = tiles.reduce<string | null>((max, t) => (t.last && (!max || t.last.at > max) ? t.last.at : max), null);
    return { range: r, tiles, as_of: asOf };
  },
);

/**
 * Fetch now rather than at the next tick: after the first deploy, or
 * when the page wants fresher prices than the scheduler brings.
 */
export const refreshQuotesNow = api(
  { expose: true, method: "POST", path: "/finance/quotes/refresh", auth: true },
  async ({ accounts }: { accounts?: string }): Promise<RefreshStats> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const depots = await visibleDepots(auth, parseAccountIds(accounts));
    // Asked by hand: a security without a symbol is asked again at once.
    return refreshQuotes(await activePositions(depots.map((d) => d.id)), new Date(), { retryUnresolved: true });
  },
);
