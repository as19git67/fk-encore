/**
 * Direct debits still expected in a period (#1526).
 *
 * "Welche Lastschriften muss ich in diesem Monat noch erwarten?" — the answer
 * sits in `finance_recurring_mandate`, which the anomaly detector keeps up to
 * date (`last_seen`, `typical_interval_days`, `typical_amount`). Until now only
 * the overdue side of it surfaced, as `missing_transaction` anomalies. This
 * lists the next expected bookings of every running series: the Lastschriften
 * page (Finanzen › Erwartete Zahlungen) and the assistant's `upcoming_payments` tool.
 *
 * The next date is computed from `last_seen`, not counted forward from the
 * previous estimate: a monthly series on the 1st stays on the 1st however many
 * months the window spans. Intervals near a calendar cadence (month, quarter,
 * half year, year) step by calendar months; anything else by days.
 *
 * Whether a series is regular is read from its bookings, not from the
 * mandate's counters: the detector's `typical_interval_days` is a running
 * average that a shop visited every few weeks for a different amount each
 * time satisfies as well as an insurer does. A series counts when its recent
 * intervals and amounts vary little (`seriesProfile`); the cadence and the
 * amount it is listed with are the medians of those bookings. A series that
 * went on under another mandate — the insurer moved to a new account, the
 * bank issued a new mandate reference — is superseded by that one and not
 * listed twice (`isSuperseded`, the same test the detector uses to keep a
 * "missing booking" alert from firing on a series that merely moved).
 *
 * Only outgoing series count, and not card payments — a card bought at the
 * same shop every few weeks is a habit, not something the bank will debit.
 * Cash accounts are left out for the same reason: nothing is debited from a
 * wallet. `channel` narrows to the direct debits (SEPA mandates) or to the
 * transfers (standing orders); by default both show, so the page is honest
 * about what it lists — expected payments, not only Lastschriften.
 */

import { api, APIError, Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, asc, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { financeAccount, financeAccountType, financeRecurringMandate } from "../db/schema";
import { readableFinanceAccountIds } from "./account-acl";
import { isLikelySeriesContinuation } from "./anomaly-detector";

/**
 * A series that missed this many cycles has ended. Two: one missed booking
 * is late, the second says the contract is gone — a monthly series silent
 * since spring is not "expected next month".
 */
export const ENDED_AFTER_INTERVALS = 2;
/** Recent bookings a series is judged by. */
export const SAMPLE_SIZE = 12;
/** Widest spread (stddev / mean) of the recent intervals for a regular series. */
export const MAX_INTERVAL_CV = 0.3;
/**
 * Widest spread of the recent amounts. An insurer raising its premium or a
 * utility adjusting the instalment stays well below it; a shop where every
 * order is a different basket does not.
 */
export const MAX_AMOUNT_CV = 0.35;
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
  return daysBetween(lastSeen, today) > intervalDays * ENDED_AFTER_INTERVALS + OVERDUE_GRACE_DAYS;
}

// ── regularity ────────────────────────────────────────────────────────────

export interface Booking {
  date: string;
  /** Signed, as booked. */
  amount: number;
}

/** The amount is the level of the newest bookings, not of the whole sample. */
const AMOUNT_RECENT = 3;

export interface SeriesProfile {
  /** Median gap between consecutive bookings, in days. */
  intervalDays: number;
  /**
   * Signed amount in cents: the median of the newest few bookings, so a
   * raised premium is listed at its new level, and one odd booking is not.
   */
  amountCents: number;
  intervalCv: number;
  amountCv: number;
  count: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** stddev / |mean|, or Infinity when the mean is zero. */
function cv(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return Number.POSITIVE_INFINITY;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

/**
 * What the recent bookings of a series say about it, or null with fewer
 * than `MIN_TRANSACTIONS` of them. Bookings on the same day count once —
 * a split booking is one payment, not an interval of zero.
 */
export function seriesProfile(bookings: Booking[]): SeriesProfile | null {
  const byDay = new Map<string, number>();
  for (const b of bookings) byDay.set(b.date, (byDay.get(b.date) ?? 0) + b.amount);
  const dates = [...byDay.keys()].sort();
  if (dates.length < MIN_TRANSACTIONS) return null;
  const intervals: number[] = [];
  for (let i = 1; i < dates.length; i++) intervals.push(daysBetween(dates[i - 1]!, dates[i]!));
  const amounts = dates.map((d) => Math.abs(byDay.get(d)!));
  const sign = Math.sign(byDay.get(dates[dates.length - 1]!) ?? 0) || -1;
  return {
    intervalDays: Math.round(median(intervals)),
    amountCents: sign * Math.round(median(amounts.slice(-AMOUNT_RECENT)) * 100),
    intervalCv: cv(intervals),
    amountCv: cv(amounts),
    count: dates.length,
  };
}

/** A series whose recent bookings keep their cadence and their amount. */
export function isRegular(profile: SeriesProfile): boolean {
  return profile.intervalCv <= MAX_INTERVAL_CV
    && profile.amountCv <= MAX_AMOUNT_CV
    && profile.intervalDays >= MIN_INTERVAL_DAYS
    && profile.intervalDays <= MAX_INTERVAL_DAYS;
}

export interface SeriesIdentity {
  id: number;
  counterparty: string | null;
  typical_amount: string | null;
  typical_interval_days: number | null;
  first_seen: string | null;
  last_seen: string | null;
}

/**
 * True when another series began after this one fell silent and looks like
 * its continuation — same creditor by name, same amount within tolerance,
 * begun within a few cycles. The insurer that moved to another account, the
 * mandate the bank re-issued: one series, listed once, under its newest
 * identity.
 */
export function isSuperseded(series: SeriesIdentity, others: SeriesIdentity[]): boolean {
  if (!series.counterparty || !series.last_seen) return false;
  const lastSeen = series.last_seen.slice(0, 10);
  return others.some((other) => {
    if (other.id === series.id || !other.counterparty) return false;
    const began = (other.first_seen ?? other.last_seen)?.slice(0, 10);
    if (!began || began <= lastSeen) return false;
    return isLikelySeriesContinuation({
      previousCounterparty: series.counterparty!,
      nextCounterparty: other.counterparty,
      previousAmount: series.typical_amount,
      nextAmount: other.typical_amount,
      previousDate: lastSeen,
      nextDate: began,
      intervalDays: series.typical_interval_days,
    });
  });
}

/**
 * The recent bookings of each mandate, newest first, matched the way the
 * detector matches them: by mandate reference, else by the creditor's IBAN,
 * else by the counterparty's name.
 */
async function recentBookings(mandateIds: number[]): Promise<Map<number, Booking[]>> {
  const out = new Map<number, Booking[]>();
  if (!mandateIds.length) return out;
  const rows = await db.execute<{ mandate_id: number; booking_date: string; amount: string }>(sql`
    SELECT mandate_id, booking_date, amount FROM (
      SELECT
        frm.id AS mandate_id,
        ft.booking_date,
        ft.amount,
        ROW_NUMBER() OVER (PARTITION BY frm.id ORDER BY ft.booking_date DESC, ft.id DESC) AS rn
      FROM finance_recurring_mandate frm
      JOIN finance_transaction ft ON ft.account_id = frm.account_id
        AND (
          (frm.mandate_ref IS NOT NULL AND ft.mandate_ref = frm.mandate_ref)
          OR (frm.mandate_ref IS NULL AND frm.counterparty_iban IS NOT NULL AND ft.counterparty_iban = frm.counterparty_iban)
          OR (frm.mandate_ref IS NULL AND frm.counterparty_iban IS NULL AND ft.counterparty = frm.counterparty)
        )
      WHERE frm.id IN (${sql.join(mandateIds.map((id) => sql`${id}`), sql`, `)})
    ) recent
    WHERE rn <= ${SAMPLE_SIZE}
  `);
  for (const r of rows.rows) {
    const list = out.get(Number(r.mandate_id)) ?? [];
    list.push({ date: String(r.booking_date).slice(0, 10), amount: Number(r.amount) });
    out.set(Number(r.mandate_id), list);
  }
  return out;
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

export type UpcomingChannel = "all" | "direct_debit" | "transfer";

export interface UpcomingDebitsParams {
  /** First day of the window, ISO. Default: today. */
  from?: Query<string>;
  /** Last day of the window, ISO. Default: end of the month `from` is in. */
  until?: Query<string>;
  /**
   * "direct_debit": SEPA direct debits only; "transfer": transfers and
   * standing orders only; "all" (default): both, plus series whose channel
   * is unknown. Card payments and cash accounts never count.
   */
  channel?: Query<UpcomingChannel>;
}

export const listUpcomingDebits = api(
  { expose: true, method: "GET", path: "/finance/mandates/upcoming", auth: true },
  async ({ from, until, channel }: UpcomingDebitsParams): Promise<UpcomingDebitsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const wanted: UpcomingChannel = channel ?? "all";
    if (!["all", "direct_debit", "transfer"].includes(wanted)) {
      throw APIError.invalidArgument("channel must be all, direct_debit or transfer");
    }

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
    // Every outgoing series the caller may see, whatever its channel: a
    // transfer can be the successor of a direct debit, so the successor test
    // below needs them all. The channel narrows the candidates afterwards.
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
        first_seen: m.first_seen,
        last_seen: m.last_seen,
      })
      .from(m)
      .innerJoin(financeAccount, sql`${financeAccount.id} = ${m.account_id}`)
      .innerJoin(financeAccountType, sql`${financeAccountType.id} = ${financeAccount.type_id}`)
      .where(
        and(
          readable === null ? undefined : inArray(m.account_id, readable),
          isNull(financeAccount.closed_at),
          // Nothing is debited from a wallet: a recurring cash expense is a habit.
          sql`${financeAccountType.kind} <> 'bargeld'`,
          isNotNull(m.last_seen),
          lt(m.typical_amount, "0"),
        ),
      )
      .orderBy(asc(m.id));

    const candidates = rows.filter((row) =>
      (wanted === "all" ? row.payment_channel !== "card" : row.payment_channel === wanted)
      && row.typical_interval_days !== null
      && row.typical_interval_days >= MIN_INTERVAL_DAYS
      && row.typical_interval_days <= MAX_INTERVAL_DAYS
      && row.transaction_count >= MIN_TRANSACTIONS
      && !isSuperseded(row, rows));
    const bookings = await recentBookings(candidates.map((c) => c.id));

    const items: UpcomingDebit[] = [];
    for (const row of candidates) {
      const lastSeen = row.last_seen!.slice(0, 10);
      // The bookings decide; the mandate's counters only stand in where the
      // bookings cannot be matched (a creditor renamed, a legacy mandate).
      const profile = seriesProfile(bookings.get(row.id) ?? []);
      if (profile && !isRegular(profile)) continue;
      const interval = profile?.intervalDays ?? row.typical_interval_days!;
      const amountCents = profile?.amountCents ?? toCents(row.typical_amount!);
      if (amountCents >= 0) continue;
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
          typical_amount: fromCents(amountCents),
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
