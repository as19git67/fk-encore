/**
 * Keeps the quotes of every held security current.
 *
 * Every five minutes while German markets trade (Xetra 9:00–17:30, the
 * regional exchanges until 22:00), hourly otherwise — a fund's price
 * changes once a day, and the provider is not to be asked for nothing.
 * After a rate limit the next tick waits a quarter of an hour. Each run
 * logs what it did, so a quiet log means no run, not a silent failure.
 *
 * The news run hourly; `refreshNews` keeps to the news provider's daily
 * budget itself, so an hourly run only spreads the calls over the day.
 */

import log from "encore.dev/log";

import { everyMs, schedule } from "../lib/local-cron";

import db from "../db/database";
import { financeAccount, financeAccountType } from "../db/schema";
import { eq, isNull, and } from "drizzle-orm";
import { activePositions, refreshQuotes } from "./quotes";
import { refreshNews } from "./news";

console.log("[boot] finance/quotes-cron.ts: all imports resolved");

const TICK_MINUTES = 5;
const QUIET_MINUTES = 60;
const BACKOFF_MINUTES = 15;

/** Whether a German exchange trades at this moment (Berlin time, weekdays 8–22). */
export function marketsOpen(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  if (weekday === "Sat" || weekday === "Sun") return false;
  return hour >= 8 && hour < 22;
}

let backoffUntil: Date | null = null;

/**
 * When the next tick fires: after a rate limit at the end of the backoff,
 * else in five minutes while markets trade and in an hour otherwise. The
 * cadence lives here, in the schedule, so that a run started by hand
 * (the admin's "run now") always runs.
 */
export function nextQuoteTick(after: Date, backoff: Date | null): Date {
  if (backoff && backoff > after) return backoff;
  return new Date(after.getTime() + (marketsOpen(after) ? TICK_MINUTES : QUIET_MINUTES) * 60_000);
}

async function openDepotIds(): Promise<number[]> {
  const rows = await db
    .select({ id: financeAccount.id })
    .from(financeAccount)
    .innerJoin(financeAccountType, eq(financeAccountType.id, financeAccount.type_id))
    .where(and(eq(financeAccountType.kind, "depot"), isNull(financeAccount.closed_at)));
  return rows.map((r) => r.id);
}

export async function refreshQuotesTick(now = new Date()): Promise<void> {
  if (backoffUntil && now < backoffUntil) {
    log.info("quote refresh skipped: the provider asked to wait", { until: backoffUntil.toISOString() });
    return;
  }
  const stats = await refreshQuotes(await activePositions(await openDepotIds()), now);
  backoffUntil = stats.rate_limited ? new Date(now.getTime() + BACKOFF_MINUTES * 60_000) : null;
}

/** For tests: forget a backoff. */
export function resetQuoteBackoff(): void {
  backoffUntil = null;
}

schedule({
  name: "finance-quotes-refresh",
  description: "Fetch current prices of the securities the depots hold",
  service: "finance",
  scheduleLabel: `every ${TICK_MINUTES}m while markets trade, hourly otherwise`,
  nextFire: (after) => nextQuoteTick(after, backoffUntil),
  run: () => refreshQuotesTick(),
});

schedule({
  name: "finance-news-refresh",
  description: "Fetch news about the held equities within the news provider's daily budget",
  service: "finance",
  scheduleLabel: "every 1h",
  nextFire: everyMs(60 * 60_000),
  run: async () => {
    await refreshNews(await activePositions(await openDepotIds()));
  },
});
