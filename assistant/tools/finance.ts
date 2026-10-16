/**
 * Finance read tools. Each wraps a finance endpoint, so `finance.view` and
 * the per-account ACL apply exactly as on the finance pages.
 */

import { finance } from "~encore/clients";
import { digestOf, int, isoDate, money, query, str, table } from "../format";
import type { ToolSpec } from "../types";

const FINANCE = ["module.finance", "finance.view"];

interface AccountView { id: number; label: string; type_label?: string | null; currency_code?: string; closed_at?: string | null }
interface TransactionView {
  id: number; account_id: number; booking_date: string; amount: string; currency_code?: string;
  counterparty: string | null; purpose: string | null; tags?: { name: string }[];
}
interface AnalysisResult {
  total: { sum: number; count: number; avg: number };
  byPeriod?: { period: string; sum: number; count: number }[];
  byTag?: { tag: string; sum: number; count: number }[];
  topCounterparties?: { name: string; sum: number; count: number }[];
  ast?: { timespan?: { from?: string; to?: string } };
}
interface UpcomingDebit {
  mandate_id: number; account_label: string; counterparty: string | null; expected_date: string;
  overdue: boolean; typical_amount: string; interval_days: number;
}

export const listAccounts: ToolSpec = {
  name: "list_accounts",
  kind: "read",
  summary: "The user's bank and depot accounts (id, label, type); use the id to filter bookings.",
  permissions: FINANCE,
  source: "hand",
  parameters: { type: "object", properties: {} },
  async run() {
    const res = await (finance.listAccounts()) as unknown as { items: AccountView[] };
    const rows = res.items.filter((a) => !a.closed_at);
    return {
      text: table(["id", "label", "type", "currency"], rows.map((a) => [a.id, a.label, a.type_label, a.currency_code])),
      digest: digestOf("list_accounts", rows.length, rows.map((a) => a.id)),
      rowCount: rows.length,
      block: { kind: "accounts", tool: "list_accounts", rows: rows.map((a) => ({ id: a.id, label: a.label, type: a.type_label ?? null })) },
    };
  },
};

export const listTransactions: ToolSpec = {
  name: "list_transactions",
  kind: "read",
  summary: "Finance bookings filtered by text (counterparty or purpose), date range, account and tags; newest first. For sums use analyze_spending.",
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
      limit,
    })) as unknown as { items: TransactionView[]; total: number };
    const rows = res.items;
    // The transaction list is per account, so only a search within one
    // account has a list page showing the same set.
    const accountId = int(args.account_id);
    const route = accountId !== undefined
      ? `/finanzen/uebersicht/konto/${accountId}${query({
          q: str(args.q), dateFrom: isoDate(args.from), dateTo: isoDate(args.to), tags: tags.join(",") || undefined,
        })}`
      : undefined;
    return {
      text: table(
        ["id", "date", "amount", "counterparty", "purpose", "tags"],
        rows.map((t) => [t.id, t.booking_date.slice(0, 10), money(t.amount), t.counterparty, t.purpose, (t.tags ?? []).map((x) => x.name).join(",")]),
        { total: res.total, cap: limit, note: "Amounts in EUR; negative = money out. Do not add these up yourself — use analyze_spending for sums." },
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

export const upcomingDirectDebits: ToolSpec = {
  name: "upcoming_direct_debits",
  kind: "read",
  summary: "Direct debits of standing mandates still expected in a period, with typical amount and the server-computed sum.",
  permissions: FINANCE,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "first day, YYYY-MM-DD (default today)" },
      until: { type: "string", description: "last day, YYYY-MM-DD (default end of this month)" },
    },
  },
  async run(args) {
    const res = await (finance.listUpcomingDebits({ from: isoDate(args.from), until: isoDate(args.until) })) as unknown as { from: string; until: string; items: UpcomingDebit[]; count: number; total_amount: string };
    return {
      text: table(
        ["mandate_id", "expected", "counterparty", "account", "typical_amount", "overdue"],
        res.items.map((d) => [d.mandate_id, d.expected_date, d.counterparty, d.account_label, money(d.typical_amount), d.overdue ? "yes" : ""]),
        { cap: 40, note: `window ${res.from} to ${res.until}; sum of typical amounts: ${money(res.total_amount)} EUR` },
      ),
      digest: `[earlier result of upcoming_direct_debits: ${res.count} expected, sum ${money(res.total_amount)}]`,
      rowCount: res.count,
      block: {
        kind: "debits",
        tool: "upcoming_direct_debits",
        rows: res.items.map((d) => ({ ...d })),
        total: res.count,
        route: `/finanzen/lastschriften${query({})}`,
      },
    };
  },
};

export const FINANCE_TOOLS = [listAccounts, listTransactions, analyzeSpending, upcomingDirectDebits];
