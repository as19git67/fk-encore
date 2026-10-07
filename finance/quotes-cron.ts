/**
 * Keeps the quotes of every held security current.
 *
 * Every five minutes while German markets trade (Xetra 9:00–17:30, the
 * regional exchanges until 22:00), hourly otherwise — a fund's price
 * changes once a day, and the provider is not to be asked for nothing.
 * After a rate limit the next tick waits a quarter of an hour.
 */

import { everyMs, schedule } from "../lib/local-cron";

import db from "../db/database";
import { financeAccount, financeAccountType } from "../db/schema";
import { eq, isNull, and } from "drizzle-orm";
import { activePositions, refreshQuotes } from "./quotes";

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

let lastRunAt: Date | null = null;
let backoffUntil: Date | null = null;

/** Whether this tick should fetch, given when the last one did. */
export function dueNow(now: Date, last: Date | null, backoff: Date | null): boolean {
  if (backoff && now < backoff) return false;
  if (!last) return true;
  const minutes = (now.getTime() - last.getTime()) / 60_000;
  return minutes >= (marketsOpen(now) ? TICK_MINUTES : QUIET_MINUTES) - 0.5;
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
  if (!dueNow(now, lastRunAt, backoffUntil)) return;
  lastRunAt = now;
  const stats = await refreshQuotes(await activePositions(await openDepotIds()), now);
  backoffUntil = stats.rate_limited ? new Date(now.getTime() + BACKOFF_MINUTES * 60_000) : null;
}

schedule({
  name: "finance-quotes-refresh",
  description: "Fetch current prices of the securities the depots hold",
  service: "finance",
  scheduleLabel: `every ${TICK_MINUTES}m while markets trade, hourly otherwise`,
  nextFire: everyMs(TICK_MINUTES * 60_000),
  run: () => refreshQuotesTick(),
});
