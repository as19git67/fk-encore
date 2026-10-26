/**
 * Finance read tools. Each wraps a finance endpoint, so `finance.view` and
 * the per-account ACL apply exactly as on the finance pages.
 */

import { finance } from "~encore/clients";
import { bool, digestOf, int, isoDate, money, query, str, table } from "../format";
import type { ToolSpec } from "../types";
import { dateKey, groupProperties, groupRows, parseGrouping, parseRanking, rankNote, rankProperties, type RankField } from "./ranking";
import { parseAmountBound, parseDirection, type TransactionCriteria } from "../../finance/transaction-conditions";
import { parseGroupBy, type TotalsGroupBy, type TransactionTotals } from "../../finance/transaction-totals";

const FINANCE = ["module.finance", "finance.view"];

interface OverviewAccount {
  id: number; label: string; type_kind: string; type_label: string; currency_code: string;
  balance: string | null; balance_as_of: string | null;
}
interface Overview { sections: { name: string; accounts: OverviewAccount[] }[]; unassigned: OverviewAccount[] }

/** An account as placed on the user's Übersicht page, with its section. */
interface PlacedAccount extends OverviewAccount { section: string | null }

/**
 * The accounts the user holds, in the order and sections of their Übersicht
 * page, with the latest balance; accounts they can see but have not placed
 * come last. This is the list the user means by "meine Konten" — not every
 * account of the household, and not the raw account table.
 */
async function placedAccounts(): Promise<PlacedAccount[]> {
  const res = (await finance.getOverview()) as unknown as Overview;
  return [
    ...res.sections.flatMap((s) => s.accounts.map((a) => ({ ...a, section: s.name }))),
    ...res.unassigned.map((a) => ({ ...a, section: null })),
  ];
}

/** One placed account, or undefined when it is not the user's or the overview is unavailable. */
async function placedAccount(id: number): Promise<PlacedAccount | undefined> {
  try {
    return (await placedAccounts()).find((a) => a.id === id);
  } catch {
    // The booking list stands on its own; the heading is extra.
    return undefined;
  }
}

/** "1234.56 EUR (as of 2026-10-14)", or why there is none. */
function balanceText(a: OverviewAccount): string {
  if (a.balance === null) return a.type_kind === "bargeld" ? "none (cash account)" : "none";
  return `${money(a.balance)} ${a.currency_code}${a.balance_as_of ? ` (as of ${a.balance_as_of.slice(0, 10)})` : ""}`;
}
interface TransactionView {
  id: number; account_id: number; booking_date: string; amount: string; currency_code?: string;
  counterparty: string | null; purpose: string | null; tags?: { name: string }[]; is_tax_relevant?: boolean;
}
interface UpcomingDebit { payment_channel?: string | null;
  mandate_id: number; account_label: string; counterparty: string | null; expected_date: string;
  overdue: boolean; typical_amount: string; interval_days: number;
}

export const listAccounts: ToolSpec = {
  name: "list_accounts",
  kind: "read",
  summary: "The user's accounts as arranged on their Übersicht page (section, label, type) with the latest balance of each; a cash account keeps no balance. Use the id to filter bookings.",
  permissions: FINANCE,
  source: "hand",
  parameters: { type: "object", properties: {} },
  async run() {
    const rows = await placedAccounts();
    return {
      text: table(
        ["id", "section", "label", "type", "balance"],
        rows.map((a) => [a.id, a.section ?? "(not on the Übersicht page)", a.label, a.type_label, balanceText(a)]),
        { note: "The balance is the account's latest statement balance, not a sum of bookings. A cash account (Bargeld) and a manual account without statements have none." },
      ),
      digest: digestOf("list_accounts", rows.length, rows.map((a) => a.id)),
      rowCount: rows.length,
      block: {
        kind: "accounts",
        tool: "list_accounts",
        rows: rows.map((a) => ({
          id: a.id, label: a.label, type: a.type_label ?? null, section: a.section,
          balance: a.balance, balance_as_of: a.balance_as_of, currency: a.currency_code,
          route: `/finanzen/uebersicht/konto/${a.id}`,
        })),
        route: "/finanzen/uebersicht",
      },
    };
  },
};

/** What a booking list is ranked by, in the words of the tool and of the finance service (`sortBy` of GET /finance/transactions). */
const RANK_FIELDS = {
  booking_date: { description: "booking date", sortBy: "date" },
  amount: { description: "absolute amount ('die größte Buchung')", sortBy: "amount" },
} satisfies Record<string, RankField & { sortBy: "date" | "amount" }>;

const GROUPS = {
  month: "YYYY-MM",
  quarter: "YYYY-Qn",
  year: "YYYY",
  account: "id",
  counterparty: "as written",
} as const;
type TransactionGroup = keyof typeof GROUPS;

/** Rows the service is asked for when the result is grouped: the most it returns. */
const GROUPED_CAP = 500;

function groupKey(t: TransactionView, by: TransactionGroup): string | undefined {
  if (by === "account") return String(t.account_id);
  if (by === "counterparty") return t.counterparty?.trim() || undefined;
  return dateKey(t.booking_date, by);
}

export const listTransactions: ToolSpec = {
  name: "list_transactions",
  kind: "read",
  summary: "Finance bookings filtered by text (counterparty or purpose), date range, account, tags, direction, amount range and the tax-relevant flag; newest first, or by amount (rank_by, direction), optionally the first of every month, quarter, year, account or counterparty (group_by). For 'Ausgaben' (expenses, spending) set direction \"out\", for 'Einnahmen' (income) \"in\"; only 'Buchungen' without either word lists both. For sums use transaction_totals.",
  permissions: FINANCE,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "text in counterparty or purpose, or an amount" },
      from: { type: "string", description: "first booking date, YYYY-MM-DD" },
      to: { type: "string", description: "last booking date, YYYY-MM-DD" },
      account_id: { type: "integer", description: "id from list_accounts" },
      tags: { type: "array", items: { type: "string" }, description: "the user's tags, all must match" },
      direction: { type: "string", enum: ["out", "in"], description: "\"out\" = only money out (Ausgaben, amount < 0), \"in\" = only money in (Einnahmen, amount > 0); omit for both" },
      tax_relevant: { type: "boolean", description: "only bookings flagged as relevant for the tax return (true) or not flagged (false)" },
      amount_min: { type: "number", description: "smallest absolute amount in the account currency, inclusive; 100 matches a 100 expense and a 100 credit" },
      amount_max: { type: "number", description: "largest absolute amount, inclusive" },
      ...rankProperties(RANK_FIELDS, "booking_date"),
      ...groupProperties(GROUPS),
      limit: { type: "integer", description: "rows to return, at most 50 (default 25); with group_by: groups shown" },
    },
  },
  async run(args) {
    const limit = int(args.limit, { min: 1, max: 50 }) ?? 25;
    const tags = Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === "string") : [];
    const direction = parseDirection(args.direction);
    const ranking = parseRanking(args, RANK_FIELDS, "booking_date");
    const grouping = parseGrouping(args, GROUPS);
    const res = await (finance.listTransactions({
      q: str(args.q),
      from: isoDate(args.from),
      to: isoDate(args.to),
      accountId: int(args.account_id),
      tagsCsv: tags.length ? tags.join(",") : undefined,
      taxRelevant: bool(args.tax_relevant),
      amountMin: parseAmountBound(args.amount_min),
      amountMax: parseAmountBound(args.amount_max),
      direction,
      sortBy: RANK_FIELDS[ranking.field].sortBy,
      sortDir: ranking.direction,
      limit: grouping ? GROUPED_CAP : limit,
    })) as unknown as { items: TransactionView[]; total: number };
    const groups = grouping ? groupRows(res.items, (t) => groupKey(t, grouping.by), grouping.perGroup) : undefined;
    const rows = groups ? groups.flatMap((g) => g.rows.map((t) => ({ ...t, group: g.key }))) : res.items.map((t) => ({ ...t, group: undefined as string | undefined }));
    const rowCap = groups ? Math.min(rows.length, limit * grouping!.perGroup) : limit;
    const total = groups ? rows.length : res.total;
    const groupedCapNote = groups && res.total > res.items.length
      ? ` Only the first ${res.items.length} of ${res.total} bookings in this order were grouped; a group outside them is missing.`
      : "";
    // The transaction list is per account, so only a search within one
    // account has a list page showing the same set — and a heading naming
    // the account and its balance, as the list page has; the page takes the
    // amount and direction filters from the link too.
    const accountId = int(args.account_id);
    const account = accountId !== undefined ? await placedAccount(accountId) : undefined;
    const subtitle = account ? `${account.label} · Saldo ${account.balance === null ? "–" : `${money(account.balance)} ${account.currency_code}`}` : undefined;
    const route = accountId !== undefined
      ? `/finanzen/uebersicht/konto/${accountId}${query({
          q: str(args.q), dateFrom: isoDate(args.from), dateTo: isoDate(args.to), tags: tags.join(",") || undefined,
          amountMin: parseAmountBound(args.amount_min), amountMax: parseAmountBound(args.amount_max),
          direction,
        })}`
      : undefined;
    return {
      text: table(
        [...(groups ? ["group"] : []), "id", "date", "amount", "counterparty", "purpose", "tags", "tax"],
        rows.map((t) => [...(groups ? [t.group] : []), t.id, t.booking_date.slice(0, 10), money(t.amount), t.counterparty, t.purpose, (t.tags ?? []).map((x) => x.name).join(","), t.is_tax_relevant ? "yes" : ""]),
        {
          total, cap: rowCap,
          note: [
            account ? `Account: ${account.label}, balance ${balanceText(account)}.` : undefined,
            direction === "out" ? "Only money out (Ausgaben)." : direction === "in" ? "Only money in (Einnahmen)." : undefined,
            `${rankNote(ranking, grouping, groups?.length ?? 0)}.${groupedCapNote}`,
            "Amounts in EUR; negative = money out. Do not add these up yourself — use transaction_totals for sums.",
          ].filter(Boolean).join(" "),
        },
      ),
      digest: digestOf("list_transactions", total, rows.map((t) => t.id)),
      rowCount: rows.length,
      // Only the rows fetched: a follow-up acts on what the user saw.
      ref: { type: "transaction", ids: rows.map((t) => t.id) },
      block: {
        kind: "transactions",
        tool: "list_transactions",
        total,
        route,
        subtitle,
        rows: rows.slice(0, rowCap).map((t) => ({
          id: t.id, booking_date: t.booking_date.slice(0, 10), amount: t.amount, counterparty: t.counterparty, purpose: t.purpose,
        })),
      },
    };
  },
};

/** The list's filter and search as tool arguments: the same names list_transactions takes. */
export const CRITERIA_PROPERTIES: Record<string, Record<string, unknown>> = {
  q: { type: "string", description: "the list's search: text in counterparty, purpose or notice, or an amount" },
  from: { type: "string", description: "first booking date, YYYY-MM-DD" },
  to: { type: "string", description: "last booking date, YYYY-MM-DD" },
  account_ids: { type: "array", items: { type: "integer" }, description: "ids from list_accounts; omit for every account" },
  tags: { type: "array", items: { type: "string" }, description: "the user's tags, all must match" },
  direction: { type: "string", enum: ["out", "in"], description: "\"out\" = only money out (Ausgaben), \"in\" = only money in (Einnahmen); omit for both" },
  tax_relevant: { type: "boolean", description: "only bookings flagged tax-relevant (true) or not flagged (false)" },
  amount_min: { type: "number", description: "smallest absolute amount, inclusive" },
  amount_max: { type: "number", description: "largest absolute amount, inclusive" },
};

export const GROUP_PROPERTIES: Record<string, Record<string, unknown>> = {
  group_by: {
    type: "string",
    enum: ["none", "tag", "month", "quarter", "year"],
    description: "subtotals per tag of the user (Schlagwort) or per month, quarter or year; none = only the total",
  },
  group_tags: {
    type: "array",
    items: { type: "string" },
    description: "with group_by tag: only these tags make groups, every other booking lands in 'Sonstige'. A booking with several tags counts once, in the group of its tag combination; the tags filtered by are no group",
  },
};

/** Criteria in the shape a rule collection stores, from the tool arguments. */
export function criteriaFromArgs(args: Record<string, unknown>): TransactionCriteria {
  const tags = Array.isArray(args.tags) ? args.tags.map((t) => str(t)).filter((t): t is string => !!t) : [];
  const accounts = Array.isArray(args.account_ids)
    ? args.account_ids.map((v) => int(v)).filter((v): v is number => v !== undefined && v > 0)
    : [];
  const single = int(args.account_id);
  if (single !== undefined && !accounts.includes(single)) accounts.push(single);
  const c: TransactionCriteria = {};
  if (accounts.length) c.account_ids = accounts;
  if (tags.length) c.tags = [...new Set(tags)];
  const q = str(args.q);
  if (q) c.text = q;
  const from = isoDate(args.from);
  if (from) c.from = from;
  const to = isoDate(args.to);
  if (to) c.to = to;
  const tax = bool(args.tax_relevant);
  if (tax !== undefined) c.tax_relevant = tax;
  const min = parseAmountBound(args.amount_min);
  if (min !== undefined) c.amount_min = min;
  const max = parseAmountBound(args.amount_max);
  if (max !== undefined) c.amount_max = max;
  const direction = parseDirection(args.direction);
  if (direction) c.direction = direction;
  return c;
}

export function groupByFromArgs(args: Record<string, unknown>): { group_by: TotalsGroupBy; group_tags?: string[] } {
  const group_by = parseGroupBy(args.group_by);
  const tags = Array.isArray(args.group_tags) ? args.group_tags.map((t) => str(t)).filter((t): t is string => !!t) : [];
  return group_by === "tag" && tags.length ? { group_by, group_tags: [...new Set(tags)] } : { group_by };
}

const GROUP_LABEL: Record<TotalsGroupBy, string> = { none: "", tag: "Tag", month: "Monat", quarter: "Quartal", year: "Jahr" };

/** Euro from cents, as the tables print amounts. */
function centsText(c: number): string {
  return money(c / 100);
}

/** The totals as the model reads them: every number computed by the server. */
export function totalsText(t: TransactionTotals): string {
  const lines = [`total: ${centsText(t.total)} ${t.currency} over ${t.count} bookings`];
  if (t.first_date) lines.push(`bookings from ${t.first_date} to ${t.last_date}`);
  if (t.group_by !== "none" && t.groups.length) {
    lines.push(
      `subtotals by ${t.group_by}:`,
      table(["group", "sum", "count"], t.groups.map((g) => [g.label, centsText(g.sum), g.count]), { cap: 40 }),
    );
    if (t.group_by === "tag") lines.push("Each booking counts in exactly one group (a booking with several tags in the group of that combination), so the subtotals add up to the total.");
  }
  for (const o of t.other_currencies) {
    lines.push(`not in the total: ${o.count} bookings in ${o.currency}, ${centsText(o.total)} ${o.currency}`);
  }
  return lines.join("\n");
}

export const transactionTotals: ToolSpec = {
  name: "transaction_totals",
  kind: "read",
  summary: "Sum of the bookings the transaction list's filter and search select, with subtotals per tag or per month, quarter or year. The server does the arithmetic. Same filter names as list_transactions.",
  permissions: FINANCE,
  source: "hand",
  parameters: {
    type: "object",
    properties: { ...CRITERIA_PROPERTIES, ...GROUP_PROPERTIES },
  },
  async run(args) {
    const criteria = criteriaFromArgs(args);
    if (Object.keys(criteria).length === 0) throw new Error("say which bookings: a search, a period, tags, an account or a direction");
    const grouping = groupByFromArgs(args);
    const res = (await finance.transactionTotals({ criteria, ...grouping })) as unknown as TransactionTotals;
    return {
      text: totalsText(res),
      digest: `[earlier result of transaction_totals: sum ${centsText(res.total)} ${res.currency} over ${res.count} bookings]`,
      rowCount: res.count,
      block: {
        kind: "analysis",
        tool: "transaction_totals",
        subtitle: grouping.group_by === "none" ? undefined : `Zwischensummen nach ${GROUP_LABEL[grouping.group_by]}`,
        rows: [{
          sum: res.total / 100,
          count: res.count,
          currency: res.currency,
          groups: res.groups.map((g) => ({ label: g.label, sum: g.sum / 100, count: g.count })),
        }],
      },
    };
  },
};

const CHANNEL_LABEL: Record<string, string> = { direct_debit: "direct debit", transfer: "transfer", other: "unknown channel" };

export const upcomingPayments: ToolSpec = {
  name: "upcoming_payments",
  kind: "read",
  summary: "Recurring outgoing payments still expected in a period, estimated from the bookings so far: SEPA direct debits (Lastschriften), transfers and standing orders (Überweisungen, Daueraufträge), with typical amount, the channel of each and the server-computed sum. channel = \"direct_debit\" for Lastschriften only, \"transfer\" for Überweisungen only, default both. Never card payments or cash.",
  permissions: FINANCE,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "first day, YYYY-MM-DD (default today)" },
      until: { type: "string", description: "last day, YYYY-MM-DD (default end of this month)" },
      channel: { type: "string", enum: ["all", "direct_debit", "transfer"], description: "direct_debit for Lastschriften, transfer for Überweisungen and Daueraufträge, all (default) for both" },
    },
  },
  async run(args) {
    const channel = str(args.channel);
    const wanted = channel === "direct_debit" || channel === "transfer" ? channel : "all";
    const res = await (finance.listUpcomingDebits({ from: isoDate(args.from), until: isoDate(args.until), channel: wanted })) as unknown as { from: string; until: string; items: UpcomingDebit[]; count: number; total_amount: string };
    return {
      text: table(
        ["mandate_id", "expected", "counterparty", "account", "channel", "typical_amount", "overdue"],
        res.items.map((d) => [d.mandate_id, d.expected_date, d.counterparty, d.account_label, CHANNEL_LABEL[d.payment_channel ?? "other"] ?? d.payment_channel, money(d.typical_amount), d.overdue ? "yes" : ""]),
        { cap: 40, note: `window ${res.from} to ${res.until}, ${wanted === "all" ? "direct debits and transfers" : CHANNEL_LABEL[wanted]}; sum of typical amounts: ${money(res.total_amount)} EUR` },
      ),
      digest: `[earlier result of upcoming_payments (${wanted}): ${res.count} expected, sum ${money(res.total_amount)}]`,
      rowCount: res.count,
      block: {
        kind: "debits",
        tool: "upcoming_payments",
        subtitle: wanted === "direct_debit" ? "Nur Lastschriften" : wanted === "transfer" ? "Nur Überweisungen und Daueraufträge" : undefined,
        rows: res.items.map((d) => ({ ...d })),
        total: res.count,
        route: `/finanzen/zahlungen${query({ channel: wanted === "all" ? undefined : wanted })}`,
      },
    };
  },
};

export const FINANCE_TOOLS = [listAccounts, listTransactions, transactionTotals, upcomingPayments];
