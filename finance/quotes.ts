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
 * `refreshQuotes` is the one writer; the scheduler (`quotes-cron.ts`) and
 * the refresh endpoint both call it. `getQuotes` reads for the page.
 */

import { api, APIError } from "encore.dev/api";
import log from "encore.dev/log";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import db from "../db/database";
import { financeQuote, financeQuoteSymbol } from "../db/schema";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { latestHoldings, visibleDepots } from "./portfolio";
import { QuoteRateLimitedError, quoteProvider, type HistoryRange } from "./quote-provider";

console.log("[boot] finance/quotes.ts: all imports resolved");

/** A security some depot holds right now, keyed as holdings key it. */
export interface ActivePosition {
  key: string;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  /** Shares across the depots (scale 8). */
  amount: number;
}

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
    const p = byKey.get(key) ?? { key, isin: h.isin, wkn: h.wkn, name: h.name, amount: 0 };
    p.amount += amount;
    p.isin ??= h.isin;
    p.wkn ??= h.wkn;
    p.name ??= h.name;
    byKey.set(key, p);
  }
  return [...byKey.values()];
}

/** A failed resolution is tried again after this long (at once when asked by hand). */
const RESOLVE_RETRY_MS = 24 * 60 * 60_000;
/** A symbol resolved without its security type is asked again after this long. */
const TYPE_RETRY_MS = 24 * 60 * 60_000;
/** The day's minutes are kept this long; the closes stay. */
const INTRADAY_KEEP_DAYS = 35;
/** The closes are refreshed when the newest is older than this. */
const DAILY_STALE_MS = 20 * 60 * 60_000;

export interface RefreshStats {
  positions: number;
  resolved: number;
  unresolved: number;
  fetched: number;
  points: number;
  /** The provider turned us away; the rest of the tick was skipped. */
  rate_limited: boolean;
  errors: string[];
}

/**
 * Bring the quotes of the given securities up to date: resolve the ones
 * the provider has not been asked about, load the history of the ones
 * it has just resolved, and fetch today's prices for all.
 */
export async function refreshQuotes(
  positions: ActivePosition[],
  now = new Date(),
  opts: { retryUnresolved?: boolean } = {},
): Promise<RefreshStats> {
  const stats: RefreshStats = { positions: positions.length, resolved: 0, unresolved: 0, fetched: 0, points: 0, rate_limited: false, errors: [] };
  if (positions.length === 0) {
    log.info("quote refresh: no held security with an ISIN or WKN");
    return stats;
  }
  const provider = quoteProvider();

  const known = new Map(
    (await db.select().from(financeQuoteSymbol).where(inArray(financeQuoteSymbol.position_key, positions.map((p) => p.key))))
      .map((r) => [r.position_key, r]),
  );

  for (const p of positions) {
    try {
      let row = known.get(p.key);
      if (!row || row.provider !== provider.name) {
        // Never asked, or asked another provider: ask this one.
        row = await resolvePosition(p, now);
      } else if (
        !row.symbol &&
        (opts.retryUnresolved || (row.failed_at && now.getTime() - Date.parse(row.failed_at) >= RESOLVE_RETRY_MS))
      ) {
        row = await resolvePosition(p, now);
      } else if (
        row.symbol &&
        row.security_type === null &&
        (!row.resolved_at || now.getTime() - Date.parse(row.resolved_at) >= TYPE_RETRY_MS)
      ) {
        // Resolved before the type was kept: the news need it.
        row = await resolvePosition(p, now, row);
      }
      if (!row.symbol) {
        stats.unresolved++;
        log.info("quote provider knows no symbol for a position", { position: p.key, provider: provider.name });
        continue;
      }
      stats.resolved++;

      const ranges: HistoryRange[] = [];
      if (!row.backfilled_at) ranges.push("backfill");
      else if (await dailyStale(p.key, now)) ranges.push("recent_days");
      ranges.push("intraday");

      for (const range of ranges) {
        const series = await provider.history(row.symbol, range);
        stats.fetched++;
        stats.points += await storeSeries(p.key, series.points, series.currency ?? row.currency, range === "intraday" ? "intraday" : "daily", provider.name);
        if (range === "backfill") {
          await db.update(financeQuoteSymbol).set({ backfilled_at: now.toISOString() }).where(eq(financeQuoteSymbol.position_key, p.key));
        }
      }
    } catch (err) {
      if (err instanceof QuoteRateLimitedError) {
        stats.rate_limited = true;
        log.warn("quote provider rate limited; ending the tick", { provider: provider.name, position: p.key });
        break;
      }
      const message = (err as Error).message ?? String(err);
      stats.errors.push(`${p.key}: ${message}`);
      log.warn("quote refresh failed for a position", { position: p.key, err: message });
    }
  }

  await pruneIntraday(now);
  log.info("quote refresh done", {
    provider: provider.name,
    positions: stats.positions,
    resolved: stats.resolved,
    unresolved: stats.unresolved,
    fetched: stats.fetched,
    points: stats.points,
    errors: stats.errors.length,
    rate_limited: stats.rate_limited,
  });
  return stats;
}

async function resolvePosition(p: ActivePosition, now: Date, previous?: typeof financeQuoteSymbol.$inferSelect) {
  const provider = quoteProvider();
  const found = await provider.resolve({ isin: p.isin, wkn: p.wkn, name: p.name });
  // The same symbol from the same provider keeps its loaded history.
  const sameSymbol = previous && previous.provider === provider.name && found?.symbol === previous.symbol;
  const values = {
    position_key: p.key,
    isin: p.isin,
    wkn: p.wkn,
    provider: provider.name,
    symbol: found?.symbol ?? null,
    name: found?.name ?? null,
    exchange: found?.exchange ?? null,
    currency: found?.currency ?? null,
    resolved_at: found ? now.toISOString() : null,
    failed_at: found ? null : now.toISOString(),
    failure: found ? null : "no symbol found",
    // Another provider's (or symbol's) history does not count as this one's.
    backfilled_at: sameSymbol ? previous.backfilled_at : null,
    security_type: found?.securityType ?? null,
  };
  const [row] = await db
    .insert(financeQuoteSymbol)
    .values(values)
    .onConflictDoUpdate({ target: financeQuoteSymbol.position_key, set: values })
    .returning();
  return row!;
}

async function dailyStale(key: string, now: Date): Promise<boolean> {
  const [latest] = await db
    .select({ at: sql<string | null>`MAX(${financeQuote.at})` })
    .from(financeQuote)
    .where(and(eq(financeQuote.position_key, key), eq(financeQuote.kind, "daily")));
  if (!latest?.at) return true;
  return now.getTime() - Date.parse(latest.at) >= DAILY_STALE_MS;
}

/** Insert the points not stored yet; returns how many were new. */
async function storeSeries(
  key: string,
  points: { at: string; price: number }[],
  currency: string | null,
  kind: "daily" | "intraday",
  source: string,
): Promise<number> {
  if (points.length === 0) return 0;
  const rows = points.map((pt) => ({
    position_key: key,
    at: pt.at,
    price: pt.price.toFixed(6),
    currency,
    kind,
    source,
  }));
  const target = [financeQuote.position_key, financeQuote.at, financeQuote.kind];
  // A minute's price is final once stored. A day's bar is not: fetched
  // during the day it carries the price so far, and only the fetch after
  // the close carries the close — so it is written over.
  const written =
    kind === "daily"
      ? await db
          .insert(financeQuote)
          .values(rows)
          .onConflictDoUpdate({ target, set: { price: sql`excluded.price`, currency: sql`excluded.currency`, source: sql`excluded.source` } })
          .returning({ id: financeQuote.id })
      : await db.insert(financeQuote).values(rows).onConflictDoNothing({ target }).returning({ id: financeQuote.id });
  return written.length;
}

/** A timestamp as the driver returns it ("2026-02-04 10:00:00+00") in ISO form. */
function iso(at: string): string {
  return new Date(at).toISOString();
}

async function pruneIntraday(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - INTRADAY_KEEP_DAYS * 24 * 60 * 60_000).toISOString();
  await db.delete(financeQuote).where(and(eq(financeQuote.kind, "intraday"), lt(financeQuote.at, cutoff)));
}

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

export async function buildQuoteTiles(accountIds: number[], range: QuoteRange, now = new Date()): Promise<QuoteTile[]> {
  const positions = await activePositions(accountIds);
  if (positions.length === 0) return [];
  const keys = positions.map((p) => p.key);
  const symbols = new Map(
    (await db.select().from(financeQuoteSymbol).where(inArray(financeQuoteSymbol.position_key, keys))).map((r) => [r.position_key, r]),
  );
  const { from, kind } = rangeWindow(range, now);
  const conditions = [inArray(financeQuote.position_key, keys), eq(financeQuote.kind, kind)];
  if (from) conditions.push(gte(financeQuote.at, from));
  const rows = await db
    .select({ key: financeQuote.position_key, at: financeQuote.at, price: financeQuote.price, currency: financeQuote.currency })
    .from(financeQuote)
    .where(and(...conditions))
    .orderBy(asc(financeQuote.at));
  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byKey.get(r.key) ?? [];
    list.push(r);
    byKey.set(r.key, list);
  }
  // The newest price of each security, from either kind — a day's range
  // on a closed market would otherwise show nothing.
  const latest = await db
    .select({ key: financeQuote.position_key, at: sql<string>`MAX(${financeQuote.at})` })
    .from(financeQuote)
    .where(inArray(financeQuote.position_key, keys))
    .groupBy(financeQuote.position_key);
  const latestRows = latest.length
    ? await db
        .select({ key: financeQuote.position_key, at: financeQuote.at, price: financeQuote.price, currency: financeQuote.currency })
        .from(financeQuote)
        .where(sql`(${financeQuote.position_key}, ${financeQuote.at}) IN (${sql.join(latest.map((l) => sql`(${l.key}, ${l.at}::timestamptz)`), sql`, `)})`)
    : [];
  const lastByKey = new Map(latestRows.map((r) => [r.key, r]));

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
      if (last && (drawn.length === 0 || iso(last.at) > drawn[drawn.length - 1]!.at)) {
        drawn.push({ at: iso(last.at), price: Number(last.price).toFixed(6) });
      }
      return {
        key: p.key,
        isin: p.isin,
        wkn: p.wkn,
        name,
        amount: p.amount.toFixed(8),
        currency,
        last: last ? { at: iso(last.at), price: Number(last.price).toFixed(6) } : null,
        value: last ? (p.amount * Number(last.price)).toFixed(2) : null,
        change,
        points: drawn,
        status,
      };
    })
    .sort((a, b) => (Number(b.value ?? 0) - Number(a.value ?? 0)) || (a.name ?? "").localeCompare(b.name ?? ""));
}

export const getQuotes = api(
  { expose: true, method: "GET", path: "/finance/quotes", auth: true },
  async ({ range, accounts }: QuotesParams): Promise<QuotesResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const r = (range ?? "1m") as QuoteRange;
    if (!RANGES.includes(r)) throw APIError.invalidArgument(`range must be one of ${RANGES.join(", ")}`);
    const depots = (await visibleDepots(auth, parseAccountIds(accounts))).filter((d) => !d.closed || accounts);
    const tiles = await buildQuoteTiles(depots.map((d) => d.id), r);
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
