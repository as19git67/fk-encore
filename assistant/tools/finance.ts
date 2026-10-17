/**
 * Finance read tools. Each wraps a finance endpoint, so `finance.view` and
 * the per-account ACL apply exactly as on the finance pages.
 */

import { finance } from "~encore/clients";
import { bool, digestOf, int, isoDate, money, query, str, table } from "../format";
import type { ToolSpec } from "../types";

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
interface AnalysisResult {
  total: { sum: number; count: number; avg: number };
  byPeriod?: { period: string; sum: number; count: number }[];
  byTag?: { tag: string; sum: number; count: number }[];
  topCounterparties?: { name: string; sum: number; count: number }[];
  ast?: { timespan?: { from?: string; to?: string } };
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

export const listTransactions: ToolSpec = {
  name: "list_transactions",
  kind: "read",
  summary: "Finance bookings filtered by text (counterparty or purpose), date range, account, tags and the tax-relevant flag; newest first. For sums use analyze_spending.",
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
      tax_relevant: { type: "boolean", description: "only bookings flagged as relevant for the tax return (true) or not flagged (false)" },
      limit: { type: "integer", description: "rows to return, at most 50 (default 25)" },
    },
  },
  async run(args) {
    const limit = int(args.limit, { min: 1, max: 50 }) ?? 25;
    const tags = Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === "string") : [];
    const res = await (finance.listTransactions({
      q: str(args.q),
      from: isoDate(args.from),
      to: isoDate(args.to),
      accountId: int(args.account_id),
      tagsCsv: tags.length ? tags.join(",") : undefined,
      taxRelevant: bool(args.tax_relevant),
      limit,
    })) as unknown as { items: TransactionView[]; total: number };
    const rows = res.items;
    // The transaction list is per account, so only a search within one
    // account has a list page showing the same set — and a heading naming
    // the account and its balance, as the list page has.
    const accountId = int(args.account_id);
    const account = accountId !== undefined ? await placedAccount(accountId) : undefined;
    const subtitle = account ? `${account.label} · Saldo ${account.balance === null ? "–" : `${money(account.balance)} ${account.currency_code}`}` : undefined;
    const route = accountId !== undefined
      ? `/finanzen/uebersicht/konto/${accountId}${query({
          q: str(args.q), dateFrom: isoDate(args.from), dateTo: isoDate(args.to), tags: tags.join(",") || undefined,
        })}`
      : undefined;
    return {
      text: table(
        ["id", "date", "amount", "counterparty", "purpose", "tags", "tax"],
        rows.map((t) => [t.id, t.booking_date.slice(0, 10), money(t.amount), t.counterparty, t.purpose, (t.tags ?? []).map((x) => x.name).join(","), t.is_tax_relevant ? "yes" : ""]),
        {
          total: res.total, cap: limit,
          note: [
            account ? `Account: ${account.label}, balance ${balanceText(account)}.` : undefined,
            "Amounts in EUR; negative = money out. Do not add these up yourself — use analyze_spending for sums.",
          ].filter(Boolean).join(" "),
        },
      ),
      digest: digestOf("list_transactions", res.total, rows.map((t) => t.id)),
      rowCount: rows.length,
      // Only the rows fetched: a follow-up acts on what the user saw.
      ref: { type: "transaction", ids: rows.map((t) => t.id) },
      block: {
        kind: "transactions",
        tool: "list_transactions",
        total: res.total,
        route,
        subtitle,
        rows: rows.map((t) => ({
          id: t.id, booking_date: t.booking_date.slice(0, 10), amount: t.amount, counterparty: t.counterparty, purpose: t.purpose,
        })),
      },
    };
  },
};

export const analyzeSpending: ToolSpec = {
  name: "analyze_spending",
  kind: "read",
  summary: "Sums, counts and groupings of bookings for a question in natural language (spending per tag, month or counterparty). The server does the arithmetic.",
  permissions: FINANCE,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "the question in the user's words, including the period" },
    },
    required: ["question"],
  },
  async run(args) {
    const question = str(args.question);
    if (!question) throw new Error("question is required");
    const res = await (finance.query({ question })) as unknown as AnalysisResult;
    const lines = [
      `total: sum ${money(res.total.sum)} EUR over ${res.total.count} bookings (avg ${money(res.total.avg)})`,
    ];
    const span = res.ast?.timespan;
    if (span?.from || span?.to) lines.push(`period: ${span.from ?? "…"} to ${span.to ?? "…"}`);
    if (res.byTag?.length) {
      lines.push("by tag:", table(["tag", "sum", "count"], res.byTag.map((t) => [t.tag, money(t.sum), t.count]), { cap: 12 }));
    }
    if (res.byPeriod?.length) {
      lines.push("by period:", table(["period", "sum", "count"], res.byPeriod.map((p) => [p.period, money(p.sum), p.count]), { cap: 24 }));
    }
    if (res.topCounterparties?.length) {
      lines.push("top counterparties:", table(["name", "sum", "count"], res.topCounterparties.map((c) => [c.name, money(c.sum), c.count]), { cap: 8 }));
    }
    return {
      text: lines.join("\n"),
      digest: `[earlier result of analyze_spending: sum ${money(res.total.sum)} over ${res.total.count} bookings]`,
      rowCount: res.total.count,
      block: {
        kind: "analysis",
        tool: "analyze_spending",
        rows: [{ question, sum: res.total.sum, count: res.total.count, avg: res.total.avg, by_tag: res.byTag ?? [], by_period: res.byPeriod ?? [] }],
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

export const FINANCE_TOOLS = [listAccounts, listTransactions, analyzeSpending, upcomingPayments];
