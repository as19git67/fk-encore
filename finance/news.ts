/**
 * News about the securities the depots hold.
 *
 * A news provider (`quote-provider.ts`) is optional and may be metered:
 * EODHD's free plan allows 20 calls a day and a news request costs five.
 * `refreshNews` therefore spends a daily budget, equities only (funds and
 * ETFs rarely get news worth the calls), the securities longest unasked
 * first, and stops when the budget is spent. What it fetches is kept in
 * `finance_quote_news` for 90 days, so the news history is ours like the
 * prices.
 */

import { api, APIError } from "encore.dev/api";
import log from "encore.dev/log";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeDepotTransaction,
  financeNewsSource,
  financeProviderUsage,
  financeQuoteNews,
  financeQuoteSymbol,
} from "../db/schema";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { visibleDepots } from "./portfolio";
import { activePositions, type ActivePosition } from "./quotes";
import { QuoteRateLimitedError, newsProvider, type NewsItem } from "./quote-provider";

console.log("[boot] finance/news.ts: all imports resolved");

/** News are kept this long. */
const NEWS_KEEP_DAYS = 90;
/** A security's first fetch reaches back this far. */
const FIRST_FETCH_DAYS = 30;
/** A security is asked at most once in this span. */
const RECHECK_MS = 20 * 60 * 60_000;
/** A symbol the provider did not know is asked for again after this long. */
const RESOLVE_RETRY_MS = 30 * 24 * 60 * 60_000;

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Charge `cost` calls against the provider's allowance for today, if they
 * still fit. One statement, so two runs at once cannot both spend the last
 * calls.
 */
export async function charge(provider: string, cost: number, dailyCalls: number, now: Date): Promise<boolean> {
  if (cost > dailyCalls) return false;
  const day = utcDay(now);
  const result = await db.execute(sql`
    INSERT INTO ${financeProviderUsage} (provider, day, calls)
    VALUES (${provider}, ${day}, ${cost})
    ON CONFLICT (provider, day) DO UPDATE
      SET calls = ${financeProviderUsage.calls} + ${cost}
      WHERE ${financeProviderUsage.calls} + ${cost} <= ${dailyCalls}
    RETURNING calls
  `);
  return result.rows.length > 0;
}

/** Calls spent today. */
export async function usedToday(provider: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ calls: financeProviderUsage.calls })
    .from(financeProviderUsage)
    .where(and(eq(financeProviderUsage.provider, provider), eq(financeProviderUsage.day, utcDay(now))));
  return row?.calls ?? 0;
}

export interface NewsStats {
  candidates: number;
  asked: number;
  resolved: number;
  skipped_not_equity: number;
  items: number;
  /** Today's budget did not reach every candidate. */
  budget_spent: boolean;
  rate_limited: boolean;
  errors: string[];
}

/**
 * Fetch news for the held equities until today's budget is spent. A
 * security whose type the quote provider did not say is resolved with the
 * news provider, whose answer then decides.
 */
export async function refreshNews(positions: ActivePosition[], now = new Date()): Promise<NewsStats> {
  const stats: NewsStats = { candidates: 0, asked: 0, resolved: 0, skipped_not_equity: 0, items: 0, budget_spent: false, rate_limited: false, errors: [] };
  const provider = newsProvider();
  if (!provider || positions.length === 0) return stats;
  const metering = provider.metering;
  const pay = (cost: number) => (metering ? charge(provider.name, cost, metering.dailyCalls, now) : Promise.resolve(true));

  const keys = positions.map((p) => p.key);
  const types = new Map(
    (await db
      .select({ key: financeQuoteSymbol.position_key, type: financeQuoteSymbol.security_type })
      .from(financeQuoteSymbol)
      .where(inArray(financeQuoteSymbol.position_key, keys))).map((r) => [r.key, r.type]),
  );
  const sources = new Map(
    (await db.select().from(financeNewsSource).where(inArray(financeNewsSource.position_key, keys))).map((r) => [r.position_key, r]),
  );

  // Equities, and the ones whose type nobody knows yet; longest unasked first.
  const candidates = positions
    .filter((p) => {
      const t = types.get(p.key);
      return t === "equity" || t === null || t === undefined;
    })
    .filter((p) => {
      const s = sources.get(p.key);
      if (!s || s.provider !== provider.name) return true;
      if (!s.symbol) return !!s.failed_at && now.getTime() - Date.parse(s.failed_at) >= RESOLVE_RETRY_MS;
      return !s.checked_at || now.getTime() - Date.parse(s.checked_at) >= RECHECK_MS;
    })
    .sort((a, b) => {
      const ca = sources.get(a.key)?.checked_at ?? "";
      const cb = sources.get(b.key)?.checked_at ?? "";
      return ca.localeCompare(cb) || a.key.localeCompare(b.key);
    });
  stats.candidates = candidates.length;

  for (const p of candidates) {
    try {
      let source = sources.get(p.key);
      if (!source || source.provider !== provider.name || !source.symbol) {
        if (!(await pay(metering?.resolve ?? 0))) {
          stats.budget_spent = true;
          break;
        }
        const found = await provider.resolve({ isin: p.isin, wkn: p.wkn, name: p.name });
        const notEquity = found?.securityType && found.securityType !== "equity";
        const values = {
          position_key: p.key,
          provider: provider.name,
          symbol: found && !notEquity ? found.symbol : null,
          resolved_at: found && !notEquity ? now.toISOString() : null,
          failed_at: found && !notEquity ? null : now.toISOString(),
          checked_at: source?.provider === provider.name ? source.checked_at : null,
        };
        [source] = await db
          .insert(financeNewsSource)
          .values(values)
          .onConflictDoUpdate({ target: financeNewsSource.position_key, set: values })
          .returning();
        if (notEquity) {
          stats.skipped_not_equity++;
          continue;
        }
        if (!found) continue;
        stats.resolved++;
      }

      if (!(await pay(metering?.news ?? 0))) {
        stats.budget_spent = true;
        break;
      }
      const since = source!.checked_at
        ? new Date(Date.parse(source!.checked_at) - 60 * 60_000)
        : new Date(now.getTime() - FIRST_FETCH_DAYS * 24 * 60 * 60_000);
      const items = await provider.news(source!.symbol!, since);
      stats.asked++;
      stats.items += await storeNews(p.key, provider.name, items);
      await db.update(financeNewsSource).set({ checked_at: now.toISOString() }).where(eq(financeNewsSource.position_key, p.key));
    } catch (err) {
      if (err instanceof QuoteRateLimitedError) {
        stats.rate_limited = true;
        log.warn("news provider refused; ending the run", { provider: provider.name, position: p.key });
        break;
      }
      const message = (err as Error).message ?? String(err);
      stats.errors.push(`${p.key}: ${message}`);
      log.warn("news refresh failed for a position", { position: p.key, err: message });
    }
  }

  await pruneNews(now);
  return stats;
}

/** Insert the items not stored yet for this security; returns how many were new. */
async function storeNews(key: string, provider: string, items: NewsItem[]): Promise<number> {
  if (items.length === 0) return 0;
  const inserted = await db
    .insert(financeQuoteNews)
    .values(
      items.map((n) => ({
        position_key: key,
        provider,
        url: n.url,
        title: n.title,
        source: n.source,
        at: n.at,
        summary: n.summary,
        sentiment: n.sentiment,
      })),
    )
    .onConflictDoNothing({ target: [financeQuoteNews.position_key, financeQuoteNews.url] })
    .returning({ id: financeQuoteNews.id });
  return inserted.length;
}

async function pruneNews(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - NEWS_KEEP_DAYS * 24 * 60 * 60_000).toISOString();
  await db.delete(financeQuoteNews).where(lt(financeQuoteNews.at, cutoff));
}

// ----------------------------------------------------------------------
// Reading
// ----------------------------------------------------------------------

export interface NewsItemOut {
  id: number;
  url: string;
  title: string;
  source: string | null;
  at: string;
  summary: string | null;
  sentiment: number | null;
  provider: string;
}

interface NewsParams {
  key: string;
  limit?: number;
}

interface NewsResponse {
  items: NewsItemOut[];
  /** When the news of this security were last fetched; null when never. */
  checked_at: string | null;
}

function parseLimit(raw: number | undefined): number {
  const n = raw ?? 20;
  return Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 20;
}

/** Whether the caller's depots hold the security now or did once. */
async function positionVisible(auth: { userID: string; permissions: string[] }, key: string): Promise<boolean> {
  const ids = (await visibleDepots(auth, null)).map((d) => d.id);
  if (ids.length === 0) return false;
  if ((await activePositions(ids)).some((p) => p.key === key)) return true;
  const [tx] = await db
    .select({ id: financeDepotTransaction.id })
    .from(financeDepotTransaction)
    .where(
      and(
        inArray(financeDepotTransaction.account_id, ids),
        or(eq(financeDepotTransaction.isin, key), eq(financeDepotTransaction.wkn, key)),
      ),
    )
    .limit(1);
  return !!tx;
}

export const getPositionNews = api(
  { expose: true, method: "GET", path: "/finance/quotes/news", auth: true },
  async ({ key, limit }: NewsParams): Promise<NewsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    if (!key) throw APIError.invalidArgument("key is required");
    if (!(await positionVisible(auth, key))) throw APIError.notFound("position not found");
    const rows = await db
      .select()
      .from(financeQuoteNews)
      .where(eq(financeQuoteNews.position_key, key))
      .orderBy(desc(financeQuoteNews.at), desc(financeQuoteNews.id))
      .limit(parseLimit(limit));
    const [source] = await db
      .select({ checked_at: financeNewsSource.checked_at })
      .from(financeNewsSource)
      .where(eq(financeNewsSource.position_key, key));
    const iso = (s: string) => new Date(s).toISOString();
    return {
      items: rows.map((r) => ({
        id: r.id,
        url: r.url,
        title: r.title,
        source: r.source,
        at: iso(r.at),
        summary: r.summary,
        sentiment: r.sentiment,
        provider: r.provider,
      })),
      checked_at: source?.checked_at ? iso(source.checked_at) : null,
    };
  },
);
