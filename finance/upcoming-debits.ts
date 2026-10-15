/**
 * Direct debits still expected in a period (#1526).
 *
 * "Welche Lastschriften muss ich in diesem Monat noch erwarten?" — the answer
 * sits in `finance_recurring_mandate`, which the anomaly detector keeps up to
 * date (`last_seen`, `typical_interval_days`, `typical_amount`). Until now only
 * the overdue side of it surfaced, as `missing_transaction` anomalies. This
 * lists the next expected bookings of every running series: the Lastschriften
 * page and, later, the assistant's `upcoming_direct_debits` tool.
 *
 * The next date is computed from `last_seen`, not counted forward from the
 * previous estimate: a monthly series on the 1st stays on the 1st however many
 * months the window spans. Intervals near a calendar cadence (month, quarter,
 * half year, year) step by calendar months; anything else by days.
 *
 * Only outgoing series count, and not card payments — a card bought at the
 * same shop every few weeks is a habit, not something the bank will debit.
 */

import { api, APIError, Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, asc, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { financeAccount, financeRecurringMandate } from "../db/schema";
import { readableFinanceAccountIds } from "./account-acl";

/** A series silent for longer than this many intervals has ended. */
export const ENDED_AFTER_INTERVALS = 3;
/**
 * A booking due up to this many days before today that has not arrived yet
 * is still expected — it is late, not gone. Matches the grace the anomaly
 * detector gives before it reports the booking as missing.
 */
export const OVERDUE_GRACE_DAYS = 7;
/** Weekly is the shortest cadence worth predicting; past a year it is noise. */
const MIN_INTERVAL_DAYS = 7;
const MAX_INTERVAL_DAYS = 400;
/** Two intervals before the cadence means anything. */
const MIN_TRANSACTIONS = 3;
/** Widest window a caller may ask for. */
export const MAX_WINDOW_DAYS = 400;

// ── dates ─────────────────────────────────────────────────────────────────
//
// All arithmetic on "YYYY-MM-DD" strings in UTC, so the server's timezone
// cannot move a date by one.

function parseIso(date: string): Date {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseIso(to).getTime() - parseIso(from).getTime()) / 86_400_000);
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = parseIso(value);
  return !Number.isNaN(d.getTime()) && formatIso(d) === value;
}

export type Cadence = { months: number } | { days: number };

/**
 * The calendar cadence an observed mean interval stands for. The bands are
 * wide because the interval is an average over months of 28 to 31 days and
 * bookings shifted by weekends.
 */
export function cadenceOf(intervalDays: number): Cadence {
  if (intervalDays >= 26 && intervalDays <= 35) return { months: 1 };
  if (intervalDays >= 55 && intervalDays <= 66) return { months: 2 };
  if (intervalDays >= 84 && intervalDays <= 98) return { months: 3 };
  if (intervalDays >= 170 && intervalDays <= 195) return { months: 6 };
  if (intervalDays >= 350 && intervalDays <= 380) return { months: 12 };
  return { days: Math.round(intervalDays) };
}

/**
 * *anchor* moved forward by *steps* cadences. Months keep the anchor's day,
 * clamped to the month's last day (a series on the 31st is due on 30 April),
 * and every step starts from the anchor again so the clamp never sticks.
 */
export function addCadence(anchor: string, cadence: Cadence, steps: number): string {
  const d = parseIso(anchor);
  if ("days" in cadence) {
    d.setUTCDate(d.getUTCDate() + cadence.days * steps);
    return formatIso(d);
  }
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + cadence.months * steps, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return formatIso(target);
}

export function isEnded(lastSeen: string, intervalDays: number, today: string): boolean {
  return daysBetween(lastSeen, today) > intervalDays * ENDED_AFTER_INTERVALS;
}

export interface ExpectedDate {
  date: string;
  /** Due before today and not booked yet. */
  overdue: boolean;
}

/**
 * The dates a series is expected on within [from, until].
 *
 * Steps forward from `last_seen` until the window starts, then collects every
 * date up to its end — a weekly series yields several. One exception at the
 * front: the first date after `last_seen`, when it lies a few days before
 * today and nothing has been booked since, is still coming and is listed as
 * overdue.
 */
export function expectedDates(input: {
  lastSeen: string;
  intervalDays: number;
  from: string;
  until: string;
  today: string;
}): ExpectedDate[] {
  const { lastSeen, intervalDays, from, until, today } = input;
  const cadence = cadenceOf(intervalDays);
  const out: ExpectedDate[] = [];
  for (let step = 1; step <= 2000; step++) {
    const date = addCadence(lastSeen, cadence, step);
    if (date > until) break;
    if (date >= from) {
      out.push({ date, overdue: date < today });
      continue;
    }
    const late = daysBetween(date, today);
    if (step === 1 && from <= today && late > 0 && late <= OVERDUE_GRACE_DAYS) {
      out.push({ date, overdue: true });
    }
  }
  return out;
}

/** End of the month *date* falls in. */
export function endOfMonth(date: string): string {
  const d = parseIso(date);
  return formatIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

/** Today on the server's calendar — the day the user lives in, not UTC's. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toCents(amount: string | number): number {
  return Math.round(Number(amount) * 100);
}

function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

// ── endpoint ──────────────────────────────────────────────────────────────

export interface UpcomingDebit {
  mandate_id: number;
  account_id: number;
  account_label: string;
  counterparty: string | null;
  creditor_id: string | null;
  mandate_ref: string | null;
  payment_channel: string | null;
  expected_date: string;
  overdue: boolean;
  /** Negative: money leaving the account. */
  typical_amount: string;
  interval_days: number;
  last_seen: string;
  transaction_count: number;
}

export interface UpcomingDebitsResponse {
  from: string;
  until: string;
  items: UpcomingDebit[];
  count: number;
  /** Sum of `typical_amount` over the items, computed here so no client adds up. */
  total_amount: string;
}

export interface UpcomingDebitsParams {
  /** First day of the window, ISO. Default: today. */
  from?: Query<string>;
  /** Last day of the window, ISO. Default: end of the month `from` is in. */
  until?: Query<string>;
}

export const listUpcomingDebits = api(
  { expose: true, method: "GET", path: "/finance/mandates/upcoming", auth: true },
  async ({ from, until }: UpcomingDebitsParams): Promise<UpcomingDebitsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const today = localToday();
    const windowFrom = from || today;
    if (!isIsoDate(windowFrom) || (until && !isIsoDate(until))) {
      throw APIError.invalidArgument("from and until must be dates as YYYY-MM-DD");
    }
    const windowUntil = until || endOfMonth(windowFrom);
    if (windowUntil < windowFrom) {
      throw APIError.invalidArgument("until must not be before from");
    }
    if (daysBetween(windowFrom, windowUntil) > MAX_WINDOW_DAYS) {
      throw APIError.invalidArgument(`the window may span at most ${MAX_WINDOW_DAYS} days`);
    }

    const empty: UpcomingDebitsResponse = {
      from: windowFrom, until: windowUntil, items: [], count: 0, total_amount: "0.00",
    };
    const readable = await readableFinanceAccountIds(auth);
    if (readable !== null && readable.length === 0) return empty;

    const m = financeRecurringMandate;
    const rows = await db
      .select({
        id: m.id,
        account_id: m.account_id,
        account_label: financeAccount.label,
        counterparty: m.counterparty,
        creditor_id: m.creditor_id,
        mandate_ref: m.mandate_ref,
        payment_channel: m.payment_channel,
        typical_amount: m.typical_amount,
        typical_interval_days: m.typical_interval_days,
        transaction_count: m.transaction_count,
        last_seen: m.last_seen,
      })
      .from(m)
      .innerJoin(financeAccount, sql`${financeAccount.id} = ${m.account_id}`)
      .where(
        and(
          readable === null ? undefined : inArray(m.account_id, readable),
          isNull(financeAccount.closed_at),
          isNotNull(m.last_seen),
          lt(m.typical_amount, "0"),
          sql`${m.payment_channel} IS DISTINCT FROM 'card'`,
          gte(m.typical_interval_days, MIN_INTERVAL_DAYS),
          lte(m.typical_interval_days, MAX_INTERVAL_DAYS),
          gte(m.transaction_count, MIN_TRANSACTIONS),
        ),
      )
      .orderBy(asc(m.id));

    const items: UpcomingDebit[] = [];
    for (const row of rows) {
      const lastSeen = row.last_seen!.slice(0, 10);
      const interval = row.typical_interval_days!;
      if (isEnded(lastSeen, interval, today)) continue;
      for (const expected of expectedDates({
        lastSeen, intervalDays: interval, from: windowFrom, until: windowUntil, today,
      })) {
        items.push({
          mandate_id: row.id,
          account_id: row.account_id,
          account_label: row.account_label,
          counterparty: row.counterparty,
          creditor_id: row.creditor_id,
          mandate_ref: row.mandate_ref,
          payment_channel: row.payment_channel,
          expected_date: expected.date,
          overdue: expected.overdue,
          typical_amount: fromCents(toCents(row.typical_amount!)),
          interval_days: interval,
          last_seen: lastSeen,
          transaction_count: row.transaction_count,
        });
      }
    }

    items.sort((a, b) =>
      a.expected_date.localeCompare(b.expected_date)
      || (a.counterparty ?? "").localeCompare(b.counterparty ?? "", "de")
      || a.mandate_id - b.mandate_id);

    return {
      from: windowFrom,
      until: windowUntil,
      items,
      count: items.length,
      total_amount: fromCents(items.reduce((sum, i) => sum + toCents(i.typical_amount), 0)),
    };
  },
);
