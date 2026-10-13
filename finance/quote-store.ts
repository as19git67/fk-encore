/**
 * Reading the stored quotes (`finance_quote`) for pages other than the
 * quotes page: the newest price per security and the closes after a day.
 *
 * Kept apart from `quotes.ts`, which imports the portfolio: the portfolio
 * reads its prices from here without closing that circle.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import db from "../db/database";
import { financeQuote } from "../db/schema";

export interface StoredQuote {
  /** ISO timestamp of the price. */
  at: string;
  price: number;
  currency: string | null;
}

/** A timestamp as the driver returns it ("2026-02-04 10:00:00+00") in ISO form. */
export function isoTimestamp(at: string): string {
  return new Date(at).toISOString();
}

const berlinDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * The trading day of a price, as the depots count days: in Berlin. A close
 * stamped at local midnight is 22:00 UTC the day before.
 */
export function quoteDay(at: string): string {
  return berlinDay.format(new Date(at));
}

/**
 * Whether a quote may value a position: the same currency, or one of them
 * unknown. A price in dollars is no price for a position kept in euros.
 */
export function quoteFitsCurrency(quote: string | null, position: string | null): boolean {
  if (!quote || !position) return true;
  return quote.trim().toUpperCase() === position.trim().toUpperCase();
}

/** The newest price of each security, from the minutes or the closes. */
export async function latestQuotes(keys: string[]): Promise<Map<string, StoredQuote>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([financeQuote.position_key], {
      key: financeQuote.position_key,
      at: financeQuote.at,
      price: financeQuote.price,
      currency: financeQuote.currency,
    })
    .from(financeQuote)
    .where(inArray(financeQuote.position_key, keys))
    .orderBy(financeQuote.position_key, sql`${financeQuote.at} DESC`);
  const out = new Map<string, StoredQuote>();
  for (const r of rows) {
    const price = Number(r.price);
    if (!Number.isFinite(price)) continue;
    out.set(r.key, { at: isoTimestamp(r.at), price, currency: r.currency });
  }
  return out;
}

/** The closes of one security after the given day (Berlin), oldest first, one per day. */
export async function closesAfter(key: string, day: string): Promise<Array<StoredQuote & { day: string }>> {
  // A day's slack: the stamp of a close may lie on the evening before in UTC.
  const from = new Date(Date.parse(`${day}T00:00:00Z`) - 24 * 60 * 60_000).toISOString();
  const rows = await db
    .select({ at: financeQuote.at, price: financeQuote.price, currency: financeQuote.currency })
    .from(financeQuote)
    .where(and(eq(financeQuote.position_key, key), eq(financeQuote.kind, "daily"), sql`${financeQuote.at} >= ${from}::timestamptz`))
    .orderBy(asc(financeQuote.at));
  const byDay = new Map<string, StoredQuote & { day: string }>();
  for (const r of rows) {
    const at = isoTimestamp(r.at);
    const d = quoteDay(at);
    const price = Number(r.price);
    if (d <= day || !Number.isFinite(price)) continue;
    byDay.set(d, { at, price, currency: r.currency, day: d });
  }
  return [...byDay.values()];
}
