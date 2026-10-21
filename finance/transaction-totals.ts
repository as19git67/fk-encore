/**
 * Sums of bookings with subtotals by tag or by period, and a grand total.
 *
 * What the analysis page used to answer, now for any set the transaction
 * list can describe: its filter and search (`criteria`) or the members of a
 * transaction Sammelmappe (`collection_id`). The assistant reads the numbers
 * from here — it never adds anything up itself — and a rule collection it
 * creates keeps its grouping, so the folder's page shows the same subtotals.
 * Free of endpoints so the collections service can import it; the endpoint
 * is in transaction-totals-api.ts.
 *
 * Amounts are summed in cents. By tag, a booking with two of the user's tags
 * counts in both groups, so the subtotals can add up to more than the total;
 * `overlapping` says when that happened. A booking with none of them lands in
 * "Ohne Tag". Bookings in another currency than the main one are never folded
 * in: they are counted under `other_currencies`.
 */

import { parseAmountBound, parseDirection, type TransactionCriteria } from "./transaction-conditions";

export type TotalsGroupBy = "none" | "tag" | "month" | "quarter" | "year";

export const TOTALS_GROUP_BY: readonly TotalsGroupBy[] = ["none", "tag", "month", "quarter", "year"];

/** How a rule collection of bookings shows its sums. */
export interface TotalsSpec {
  group_by: TotalsGroupBy;
  /** By tag: only these tags get a group of their own, the rest is "Sonstige". */
  tags?: string[];
}

export const NO_TAG = "Ohne Tag";
export const OTHER_TAGS = "Sonstige";

export interface TotalsBooking {
  id: number;
  booking_date: string;
  amount: string;
  currency_code: string;
  /** The user's tags on the booking. */
  tags: string[];
}

export interface TotalsGroup {
  /** Sort key: the tag, or the period as `2026-09`, `2026-Q3`, `2026`. */
  key: string;
  /** For people: `September 2026`, `Q3 2026`, `2026`, the tag. */
  label: string;
  count: number;
  /** Cents. */
  sum: number;
}

export interface CurrencyTotal {
  currency: string;
  count: number;
  /** Cents. */
  total: number;
}

export interface TransactionTotals {
  group_by: TotalsGroupBy;
  currency: string;
  /** Bookings in the main currency. */
  count: number;
  /** Cents, main currency. */
  total: number;
  groups: TotalsGroup[];
  /** By tag: at least one booking counts in more than one group. */
  overlapping: boolean;
  /** First and last booking date of the set, YYYY-MM-DD. */
  first_date: string | null;
  last_date: string | null;
  other_currencies: CurrencyTotal[];
}

const MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function cents(amount: string): number {
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function parseGroupBy(raw: unknown): TotalsGroupBy {
  return TOTALS_GROUP_BY.includes(raw as TotalsGroupBy) ? (raw as TotalsGroupBy) : "none";
}

/** A spec as stored or received, cleaned; null for "no sums wanted". */
export function normalizeTotalsSpec(raw: unknown): TotalsSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const group_by = parseGroupBy(o.group_by);
  const tags = Array.isArray(o.tags)
    ? [...new Set(o.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean))]
    : [];
  return group_by === "tag" && tags.length ? { group_by, tags } : { group_by };
}

function periodOf(date: string, by: "month" | "quarter" | "year"): { key: string; label: string } {
  const year = date.slice(0, 4);
  const month = Number(date.slice(5, 7));
  if (by === "year") return { key: year, label: year };
  if (by === "quarter") {
    const q = Math.ceil(month / 3);
    return { key: `${year}-Q${q}`, label: `Q${q} ${year}` };
  }
  return { key: `${year}-${String(month).padStart(2, "0")}`, label: `${MONTHS[month - 1]} ${year}` };
}

/** The numbers, from bookings already loaded. */
export function computeTotals(bookings: TotalsBooking[], spec: TotalsSpec): TransactionTotals {
  const byCurrency = new Map<string, TotalsBooking[]>();
  for (const b of bookings) {
    const list = byCurrency.get(b.currency_code) ?? [];
    list.push(b);
    byCurrency.set(b.currency_code, list);
  }
  // The main currency is the one most bookings are in; EUR on a tie.
  const ranked = [...byCurrency.entries()].sort(
    (a, b) => b[1].length - a[1].length || (a[0] === "EUR" ? -1 : b[0] === "EUR" ? 1 : a[0].localeCompare(b[0])),
  );
  const currency = ranked[0]?.[0] ?? "EUR";
  const main = byCurrency.get(currency) ?? [];
  const other_currencies = ranked.slice(1).map(([c, list]) => ({
    currency: c,
    count: list.length,
    total: list.reduce((s, b) => s + cents(b.amount), 0),
  }));

  const groups = new Map<string, TotalsGroup>();
  const add = (key: string, label: string, amount: number) => {
    const g = groups.get(key) ?? { key, label, count: 0, sum: 0 };
    g.count += 1;
    g.sum += amount;
    groups.set(key, g);
  };
  let overlapping = false;
  const only = spec.group_by === "tag" && spec.tags?.length ? new Set(spec.tags) : null;
  for (const b of main) {
    const amount = cents(b.amount);
    if (spec.group_by === "tag") {
      const tags = [...new Set(b.tags)];
      const own = only ? tags.filter((t) => only.has(t)) : tags;
      if (own.length > 1) overlapping = true;
      if (own.length) for (const t of own) add(t, t, amount);
      else add(only && tags.length ? OTHER_TAGS : NO_TAG, only && tags.length ? OTHER_TAGS : NO_TAG, amount);
    } else if (spec.group_by !== "none") {
      const p = periodOf(b.booking_date.slice(0, 10), spec.group_by);
      add(p.key, p.label, amount);
    }
  }

  const sorted = [...groups.values()];
  if (spec.group_by === "tag") {
    // Biggest movement first; then the other tags, then the untagged.
    const tail = (g: TotalsGroup) => (g.key === NO_TAG ? 2 : g.key === OTHER_TAGS ? 1 : 0);
    sorted.sort((a, b) => tail(a) - tail(b) || Math.abs(b.sum) - Math.abs(a.sum) || a.key.localeCompare(b.key));
  } else {
    sorted.sort((a, b) => a.key.localeCompare(b.key));
  }
  const dates = main.map((b) => b.booking_date.slice(0, 10)).sort();
  return {
    group_by: spec.group_by,
    currency,
    count: main.length,
    total: main.reduce((s, b) => s + cents(b.amount), 0),
    groups: sorted,
    overlapping,
    first_date: dates[0] ?? null,
    last_date: dates[dates.length - 1] ?? null,
    other_currencies,
  };
}

/** Criteria as received over the wire, trimmed to what the filter understands. */
export function cleanCriteria(raw: unknown): TransactionCriteria {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: TransactionCriteria = {};
  const ids = Array.isArray(c.account_ids)
    ? [...new Set(c.account_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  if (ids.length) out.account_ids = ids;
  const tags = Array.isArray(c.tags)
    ? [...new Set(c.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean))]
    : [];
  if (tags.length) out.tags = tags;
  if (typeof c.text === "string" && c.text.trim()) out.text = c.text.trim().slice(0, 200);
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof c.from === "string" && iso.test(c.from)) out.from = c.from;
  if (typeof c.to === "string" && iso.test(c.to)) out.to = c.to;
  if (typeof c.tax_relevant === "boolean") out.tax_relevant = c.tax_relevant;
  const min = parseAmountBound(c.amount_min);
  if (min !== undefined) out.amount_min = min;
  const max = parseAmountBound(c.amount_max);
  if (max !== undefined) out.amount_max = max;
  const direction = parseDirection(c.direction);
  if (direction) out.direction = direction;
  return out;
}
