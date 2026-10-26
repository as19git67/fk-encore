/**
 * Depots and securities (documentation/plans/ki-assistent.md): holdings,
 * gains, income, buys and sells, quotes and news. Every figure comes from the
 * finance service's portfolio endpoints, which already do the arithmetic the
 * Portfolio page shows — the model only reads them out.
 */

import { finance } from "~encore/clients";
import { digestOf, int, isoDate, money, query, str, table } from "../format";
import type { ToolSpec } from "../types";

const FINANCE = ["module.finance", "finance.view"];
const KINDS = ["buy", "sell", "in", "out", "dividend", "split", "corp_action", "tax"] as const;
const RANGES = ["1d", "1w", "1m", "3m", "1y", "max"] as const;

interface Position {
  key: string; isin: string | null; wkn: string | null; name: string | null; currency: string | null;
  account_ids: number[]; open: boolean; amount: string | null; price: string | null; price_as_of: string | null;
  price_source: "quote" | "bank" | null; value: string | null; cost_basis: string | null;
  unrealized_gain: string | null; unrealized_gain_pct: string | null; weight_pct: string | null;
  realized_gain: string | null; realized_gain_complete: boolean; income: string | null;
  yield_on_cost_pct: string | null; fees: string | null; taxes: string | null;
  total_return: string | null; total_return_pct: string | null;
  buy_count: number; sell_count: number; dividend_count: number;
  first_transaction_at: string | null; last_transaction_at: string | null;
}
interface PortfolioYear {
  year: number; realized: string; sell_count: number; realized_complete: boolean; income: string;
  dividend_count: number; fees: string; taxes: string; net_invested: string;
}
interface Summary {
  as_of: string | null; price_as_of: string | null; market_value: string; cost_basis: string; cost_basis_complete: boolean;
  unrealized_gain: string; unrealized_gain_pct: string | null; realized_gain: string; realized_gain_ytd: string;
  realized_gain_complete: boolean; income: string; income_ytd: string; fees: string; taxes: string;
  total_return: string; total_return_pct: string | null; open_positions: number; closed_positions: number; transaction_count: number;
}
interface Portfolio {
  accounts: { id: number; label: string; currency_code: string; closed: boolean }[];
  closed_hidden: number; currency: string; mixed_currency: boolean; summary: Summary; positions: Position[]; years: PortfolioYear[];
}
interface DepotTransaction {
  id: number; account_id: number; account_label: string; position_key: string; isin: string | null; wkn: string | null;
  name: string | null; kind: string; executed_at: string; amount: string | null; price: string | null;
  gross_amount: string | null; fees: string | null; tax: string | null; net_amount: string | null; currency: string | null;
}
interface PositionDetail {
  currency: string; position: Position;
  accounts: { account_id: number; account_label: string; amount: string | null; value: string | null; cost_basis: string | null }[];
  transactions: DepotTransaction[];
  sales: { transaction_id: number; executed_at: string; quantity: string; proceeds: string; cost: string | null; gain: string | null }[];
  years: { year: number; realized: string; realized_complete: boolean; sell_count: number; income: string; dividend_count: number; fees: string; taxes: string }[];
}
interface QuoteTile {
  key: string; isin: string | null; wkn: string | null; name: string | null; amount: string; currency: string | null;
  last: { at: string; price: string } | null; value: string | null; change: { absolute: string; percent: string } | null;
  status: "ok" | "unresolved" | "pending"; news_unread: number;
}
interface NewsItem { id: number; url: string; title: string; source: string | null; at: string; summary: string | null; sentiment: number | null }

const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : undefined);
const pct = (s: string | null) => (s === null ? undefined : `${money(s)} %`);
const positionRoute = (key: string) => `/finanzen/portfolio/${encodeURIComponent(key)}`;

function accountsParam(args: Record<string, unknown>): string | undefined {
  const ids = Array.isArray(args.account_ids) ? args.account_ids.map((v) => int(v)).filter((v): v is number => v !== undefined) : [];
  return ids.length ? ids.join(",") : undefined;
}

function matches(p: { name: string | null; isin: string | null; wkn: string | null; key: string }, q: string | undefined): boolean {
  if (!q) return true;
  const needle = q.toLocaleLowerCase("de");
  return [p.name, p.isin, p.wkn, p.key].some((v) => v?.toLocaleLowerCase("de").includes(needle));
}

/** The depots a position lies in, by label; ids the user cannot see stay ids. */
function depotsOf(p: Position, labels: Map<number, string>): string {
  return p.account_ids.map((id) => labels.get(id) ?? `#${id}`).join(", ");
}

function positionRows(positions: Position[], labels: Map<number, string> = new Map()) {
  return positions.map((p) => ({
    key: p.key, name: p.name ?? p.key, isin: p.isin, amount: p.amount, value: p.value, currency: p.currency,
    unrealized_gain: p.unrealized_gain, unrealized_gain_pct: p.unrealized_gain_pct, open: p.open,
    depots: depotsOf(p, labels) || null, route: positionRoute(p.key),
  }));
}

export const portfolioOverview: ToolSpec = {
  name: "portfolio_overview",
  kind: "read",
  summary: "The user's depots as one portfolio: market value, cost basis, unrealized and realized gain, income (dividends, interest), fees, taxes and total return, the positions with value, gain and the depot(s) each lies in, and realized gain and income per year. The server does all arithmetic. account_ids narrows to one depot ('welche Wertpapiere sind im Depot X'); q finds one security and its key ('in welchem Depot liegt Y').",
  permissions: FINANCE,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "only positions whose name, ISIN or WKN contains this" },
      account_ids: { type: "array", items: { type: "integer" }, description: "only these depots (ids from list_accounts); default: every depot" },
      include_closed: { type: "boolean", description: "also positions sold out completely and closed depots" },
      limit: { type: "integer", description: "positions to show, at most 100 (default 30), largest value first" },
    },
  },
  async run(args) {
    const q = str(args.q);
    const limit = int(args.limit, { min: 1, max: 100 }) ?? 30;
    const res = (await finance.getPortfolio({ accounts: accountsParam(args), closed: args.include_closed === true || undefined })) as unknown as Portfolio;
    const s = res.summary;
    const positions = res.positions.filter((p) => matches(p, q)).sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0));
    const shown = positions.slice(0, limit);
    const cur = res.currency;
    const labels = new Map(res.accounts.map((a) => [a.id, a.label]));
    const summary = [
      `Portfolio of ${res.accounts.length} depot${res.accounts.length === 1 ? "" : "s"} (${res.accounts.map((a) => `${a.label} [id ${a.id}]`).join(", ")}), figures in ${cur}${res.mixed_currency ? " (mixed currencies, converted)" : ""}, prices as of ${day(s.price_as_of) ?? "?"}:`,
      `market value ${money(s.market_value)}; cost basis ${money(s.cost_basis)}${s.cost_basis_complete ? "" : " (incomplete: some buys are unknown)"}; unrealized gain ${money(s.unrealized_gain)}${s.unrealized_gain_pct ? ` (${money(s.unrealized_gain_pct)} %)` : ""}`,
      `realized gain ${money(s.realized_gain)} (this year ${money(s.realized_gain_ytd)})${s.realized_gain_complete ? "" : " (incomplete)"}; income from dividends and interest ${money(s.income)} (this year ${money(s.income_ytd)}); fees ${money(s.fees)}; taxes ${money(s.taxes)}`,
      `total return ${money(s.total_return)}${s.total_return_pct ? ` (${money(s.total_return_pct)} %)` : ""}; ${s.open_positions} open and ${s.closed_positions} closed positions, ${s.transaction_count} transactions${res.closed_hidden ? `; ${res.closed_hidden} closed depot(s) left out` : ""}.`,
    ].join("\n");
    const positionsTable = table(
      ["key", "name", "depot", "amount", "price", "value", "unrealized gain", "%", "realized", "income", "weight %"],
      shown.map((p) => [p.key, p.name, depotsOf(p, labels), p.amount, p.price, p.value, p.unrealized_gain, pct(p.unrealized_gain_pct), p.realized_gain, p.income, p.weight_pct]),
      { total: positions.length, cap: limit, note: "key is the security's id for position_detail, depot_transactions, quotes and position_news; depot names the depot(s) holding the position." },
    );
    const yearsTable = q ? "" : "\nPer year:\n" + table(
      ["year", "realized gain", "sells", "income", "dividends", "fees", "taxes", "net invested"],
      res.years.map((y) => [y.year, y.realized + (y.realized_complete ? "" : " (incomplete)"), y.sell_count, y.income, y.dividend_count, y.fees, y.taxes, y.net_invested]),
      { cap: 30 },
    );
    return {
      text: `${summary}\n\nPositions:\n${positionsTable}${yearsTable}`,
      digest: digestOf("portfolio_overview", positions.length, positions.map((p) => p.key)),
      rowCount: positions.length,
      block: {
        kind: "positions",
        tool: "portfolio_overview",
        total: positions.length,
        subtitle: `Depotwert ${money(s.market_value)} ${cur} · unrealisiert ${money(s.unrealized_gain)} ${cur}`,
        rows: positionRows(shown, labels),
        route: "/finanzen/portfolio",
      },
    };
  },
};

export const positionDetail: ToolSpec = {
  name: "position_detail",
  kind: "read",
  summary: "One security across the user's depots: holding, price, cost basis, gains, income, total return, share per depot, every sale with its gain, figures per year and its transactions. Key from portfolio_overview (ISIN or WKN). For the transactions of several securities, or of one kind (all dividends), use depot_transactions instead.",
  permissions: FINANCE,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "the security's key, ISIN or WKN" },
      include_closed: { type: "boolean", description: "also closed depots" },
    },
    required: ["key"],
  },
  async run(args) {
    const key = str(args.key);
    if (!key) throw new Error("key is required");
    const res = (await finance.getPortfolioPosition({ key, closed: args.include_closed === true || undefined })) as unknown as PositionDetail;
    const p = res.position;
    const cur = res.currency;
    const lines = [
      `${p.name ?? p.key} (ISIN ${p.isin ?? "?"}, WKN ${p.wkn ?? "?"}), ${p.open ? "held" : "sold out"}, figures in ${cur}:`,
      `amount ${p.amount ?? "?"}; price ${p.price ?? "?"} (${p.price_source ?? "?"}, as of ${day(p.price_as_of) ?? "?"}); value ${money(p.value)}; cost basis ${money(p.cost_basis)}`,
      `unrealized gain ${money(p.unrealized_gain)}${p.unrealized_gain_pct ? ` (${money(p.unrealized_gain_pct)} %)` : ""}; realized gain ${money(p.realized_gain)}${p.realized_gain_complete ? "" : " (incomplete)"}; income ${money(p.income)}${p.yield_on_cost_pct ? ` (${money(p.yield_on_cost_pct)} % on cost)` : ""}; fees ${money(p.fees)}; taxes ${money(p.taxes)}; total return ${money(p.total_return)}${p.total_return_pct ? ` (${money(p.total_return_pct)} %)` : ""}`,
      `${p.buy_count} buys, ${p.sell_count} sells, ${p.dividend_count} dividends between ${day(p.first_transaction_at) ?? "?"} and ${day(p.last_transaction_at) ?? "?"}; weight ${pct(p.weight_pct) ?? "?"}`,
      `Per depot: ${res.accounts.map((a) => `${a.account_label}: ${a.amount ?? "?"} pieces, value ${money(a.value)}`).join("; ") || "none"}`,
    ];
    if (res.sales.length) {
      lines.push("Sales:\n" + table(["date", "quantity", "proceeds", "cost", "gain"], res.sales.map((x) => [day(x.executed_at), x.quantity, x.proceeds, x.cost, x.gain]), { cap: 30 }));
    }
    if (res.years.length) {
      lines.push("Per year:\n" + table(["year", "realized gain", "sells", "income", "dividends", "fees", "taxes"], res.years.map((y) => [y.year, y.realized + (y.realized_complete ? "" : " (incomplete)"), y.sell_count, y.income, y.dividend_count, y.fees, y.taxes]), { cap: 30 }));
    }
    lines.push("Transactions:\n" + table(
      ["date", "kind", "depot", "amount", "price", "net", "fees", "tax"],
      res.transactions.map((t) => [day(t.executed_at), t.kind, t.account_label, t.amount, t.price, t.net_amount, t.fees, t.tax]),
      { cap: 25, note: "newest first; use depot_transactions for a date range" },
    ));
    return {
      text: lines.join("\n"),
      digest: digestOf("position_detail", 1, [p.key]),
      rowCount: 1,
      block: {
        kind: "positions",
        tool: "position_detail",
        subtitle: `${p.name ?? p.key} · Wert ${money(p.value)} ${cur}`,
        rows: positionRows([p], new Map(res.accounts.map((a) => [a.account_id, a.account_label]))),
        route: positionRoute(p.key),
      },
    };
  },
};

export const depotTransactions: ToolSpec = {
  name: "depot_transactions",
  kind: "read",
  summary: "Buys, sells, dividends and other depot transactions across the user's depots, newest first, with the sum of net amounts, fees and taxes the server computed; filter by security, kind and date range. For the value and gain of the holdings use portfolio_overview, for today's prices quotes.",
  permissions: FINANCE,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      position: { type: "string", description: "one security: key, ISIN or WKN from portfolio_overview" },
      kind: { type: "string", enum: [...KINDS], description: "buy, sell, dividend, in, out, split, corp_action, tax" },
      q: { type: "string", description: "text in the security's name" },
      from: { type: "string", description: "first date, YYYY-MM-DD" },
      to: { type: "string", description: "last date, YYYY-MM-DD" },
      account_ids: { type: "array", items: { type: "integer" }, description: "only these depots; default: every depot" },
      limit: { type: "integer", description: "rows to return, at most 100 (default 25)" },
    },
  },
  async run(args) {
    const limit = int(args.limit, { min: 1, max: 100 }) ?? 25;
    const kind = str(args.kind);
    if (kind && !(KINDS as readonly string[]).includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
    const res = (await finance.listPortfolioTransactions({
      accounts: accountsParam(args), position: str(args.position), kind, q: str(args.q),
      from: isoDate(args.from), to: isoDate(args.to), limit, sortBy: "executed_at", sortDir: "desc",
    })) as unknown as { items: DepotTransaction[]; total: number; sums: { net_amount: string; fees: string; taxes: string } };
    const rows = res.items;
    return {
      text: table(
        ["id", "date", "kind", "name", "depot", "amount", "price", "net", "fees", "tax", "currency"],
        rows.map((t) => [t.id, day(t.executed_at), t.kind, t.name ?? t.position_key, t.account_label, t.amount, t.price, t.net_amount, t.fees, t.tax, t.currency]),
        {
          total: res.total, cap: limit,
          note: `Sum over all ${res.total} matching transactions (server-computed): net ${money(res.sums.net_amount)}, fees ${money(res.sums.fees)}, taxes ${money(res.sums.taxes)}. Net of a buy is negative (money out), of a sell or dividend positive.`,
        },
      ),
      digest: digestOf("depot_transactions", res.total, rows.map((t) => t.id)),
      rowCount: rows.length,
      block: {
        kind: "depot_transactions",
        tool: "depot_transactions",
        total: res.total,
        subtitle: `Netto ${money(res.sums.net_amount)} · Gebühren ${money(res.sums.fees)} · Steuern ${money(res.sums.taxes)}`,
        rows: rows.map((t) => ({
          id: t.id, executed_at: day(t.executed_at), kind: t.kind, name: t.name ?? t.position_key, account_label: t.account_label,
          amount: t.amount, net_amount: t.net_amount, currency: t.currency, route: positionRoute(t.position_key),
        })),
        route: `/finanzen/portfolio${query({ position: str(args.position), kind, q: str(args.q), from: isoDate(args.from), to: isoDate(args.to) })}`,
      },
    };
  },
};

export const quotes: ToolSpec = {
  name: "quotes",
  kind: "read",
  summary: "Current quotes of the securities the user holds: last price with its time, value of the holding, change over a range (1d, 1w, 1m, 3m, 1y, max) and the count of unread news, plus the total value and the total change of all holdings over the range — 'habe ich heute Gewinn gemacht' is range=1d. Prices come from the quote cache the server refreshes in trading hours.",
  permissions: FINANCE,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      range: { type: "string", enum: [...RANGES], description: "period of the change column (default 1m)" },
      q: { type: "string", description: "only securities whose name, ISIN or WKN contains this" },
      account_ids: { type: "array", items: { type: "integer" }, description: "only these depots" },
    },
  },
  async run(args) {
    const range = str(args.range) ?? "1m";
    if (!(RANGES as readonly string[]).includes(range)) throw new Error(`range must be one of ${RANGES.join(", ")}`);
    const q = str(args.q);
    const res = (await finance.getQuotes({ range, accounts: accountsParam(args) })) as unknown as { range: string; tiles: QuoteTile[]; as_of: string | null };
    const tiles = res.tiles.filter((t) => matches(t, q));
    // The same sums the Kurse page shows: value of the holdings with a quote,
    // and the shares' change over the range, summed.
    const priced = tiles.filter((t) => t.value !== null);
    const totalValue = priced.reduce((sum, t) => sum + Number(t.value), 0);
    const changed = tiles.filter((t) => t.change !== null);
    const totalChange = changed.reduce((sum, t) => sum + Number(t.change!.absolute) * Number(t.amount), 0);
    const rangeText: Record<string, string> = { "1d": "since yesterday", "1w": "over the week", "1m": "over the month", "3m": "over three months", "1y": "over the year", max: "since the first quote" };
    const totals = priced.length
      ? `Total value of the ${priced.length} priced holding${priced.length === 1 ? "" : "s"}: ${totalValue.toFixed(2)}; change ${rangeText[range] ?? range}: ${totalChange >= 0 ? "+" : ""}${totalChange.toFixed(2)} (${changed.length} with a comparison price). Positive = gain.`
      : "No holding has a quote yet.";
    return {
      text: totals + "\n" + table(
        ["key", "name", "amount", "last price", "at", "value", `change ${range}`, "%", "unread news"],
        tiles.map((t) => [
          t.key, t.name, t.amount, t.status === "ok" ? t.last?.price : `(${t.status})`, t.last?.at?.slice(0, 16).replace("T", " "),
          t.value, t.change?.absolute, t.change?.percent, t.news_unread,
        ]),
        { cap: 60, note: `Quotes as of ${res.as_of ?? "?"}; prices in the security's currency. "unresolved" means no quote source knows the security, "pending" that none was fetched yet.` },
      ),
      digest: digestOf("quotes", tiles.length, tiles.map((t) => t.key)),
      rowCount: tiles.length,
      block: {
        kind: "quotes",
        tool: "quotes",
        total: tiles.length,
        subtitle: priced.length
          ? `Wert ${totalValue.toFixed(2)} · ${totalChange >= 0 ? "+" : ""}${totalChange.toFixed(2)} ${({ "1d": "seit gestern", "1w": "seit einer Woche", "1m": "seit einem Monat", "3m": "seit drei Monaten", "1y": "seit einem Jahr", max: "seit Beginn" } as Record<string, string>)[range] ?? range}`
          : (res.as_of ? `Stand ${res.as_of.slice(0, 16).replace("T", " ")}` : undefined),
        rows: tiles.map((t) => ({
          key: t.key, name: t.name ?? t.key, price: t.last?.price ?? null, currency: t.currency, value: t.value,
          change_percent: t.change?.percent ?? null, status: t.status, news_unread: t.news_unread, route: positionRoute(t.key),
        })),
        route: `/finanzen/kurse${query({ range })}`,
      },
    };
  },
};

export const positionNews: ToolSpec = {
  name: "position_news",
  kind: "read",
  summary: "News about one security the user holds or held, newest first, with source, date, summary and sentiment, as the server collected them. Key from portfolio_overview or quotes.",
  permissions: FINANCE,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "the security's key, ISIN or WKN" },
      limit: { type: "integer", description: "at most 50 (default 10)" },
    },
    required: ["key"],
  },
  async run(args) {
    const key = str(args.key);
    if (!key) throw new Error("key is required");
    const limit = int(args.limit, { min: 1, max: 50 }) ?? 10;
    const res = (await finance.getPositionNews({ key, limit })) as unknown as { items: NewsItem[]; checked_at: string | null };
    const rows = res.items;
    return {
      text: table(
        ["date", "source", "title", "sentiment", "summary"],
        rows.map((n) => [n.at.slice(0, 10), n.source, n.title, n.sentiment, n.summary]),
        { cap: limit, note: `Last checked ${res.checked_at ?? "never"}; sentiment from -1 (negative) to 1 (positive), when a provider gave one.` },
      ),
      digest: digestOf("position_news", rows.length, rows.map((n) => n.id)),
      rowCount: rows.length,
      block: {
        kind: "news",
        tool: "position_news",
        total: rows.length,
        rows: rows.map((n) => ({ id: n.id, title: n.title, source: n.source, at: n.at, url: n.url, sentiment: n.sentiment })),
        route: positionRoute(key),
      },
    };
  },
};

export const DEPOT_TOOLS = [portfolioOverview, positionDetail, depotTransactions, quotes, positionNews];
