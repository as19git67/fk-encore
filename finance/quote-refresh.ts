/**
 * Writing the quotes (`finance_quote`): resolve a security at the
 * provider, load its history once, then its new closes and today's
 * minutes. `refreshQuotes` is the one writer; the scheduler
 * (`quotes-cron.ts`), the refresh endpoint (`quotes.ts`) and the demo
 * data's depot (`demo/depot-writer.ts`) call it.
 *
 * Kept apart from `quotes.ts`, which defines the endpoints, so another
 * service can load quotes without importing them.
 */

import log from "encore.dev/log";
import { and, eq, inArray, lt, sql } from "drizzle-orm";

import db from "../db/database";
import { financeQuote, financeQuoteSymbol } from "../db/schema";
import { QuoteRateLimitedError, quoteProvider, type HistoryRange } from "./quote-provider";

/** A security some depot holds right now, keyed as holdings key it. */
export interface ActivePosition {
  key: string;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  /** Shares across the depots (scale 8). */
  amount: number;
  /** The depots holding shares of it. */
  account_ids: number[];
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
        const series = await provider.history(row.symbol, range, { isin: p.isin, wkn: p.wkn });
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

async function pruneIntraday(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - INTRADAY_KEEP_DAYS * 24 * 60 * 60_000).toISOString();
  await db.delete(financeQuote).where(and(eq(financeQuote.kind, "intraday"), lt(financeQuote.at, cutoff)));
}

