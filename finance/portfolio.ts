/**
 * Portfolio — securities across every depot the caller may read (#1336).
 *
 * The per-account endpoints in holdings.ts and depot-transactions.ts
 * answer "what is in this depot". This module answers "what do I own",
 * aggregating the latest holdings snapshot of every visible depot and
 * replaying every depot transaction into one set of positions:
 *
 *   - market value, cost basis and unrealized G/L from the latest snapshot
 *     per depot (same valuation as holdings.ts: bank Einstandskurs first,
 *     weighted average cost from buys as the fallback),
 *   - realized G/L from sells, walked per depot and position with the WAC
 *     method of holdings.ts (lots live in one depot, so a transfer between
 *     depots is not a sale and must not mix the two cost bases),
 *   - income from `kind='dividend'` rows, fees and taxes from every row,
 *     each as a total and per calendar year.
 *
 * Positions are keyed by COALESCE(isin, wkn, name), the identity every
 * other depot module uses. A position with transactions but no current
 * holding (sold out, transferred away) is still returned, with `open:
 * false`, so the realized G/L and the income it produced do not vanish
 * from the yearly figures.
 *
 * Access: `finance.view` plus the account ACL (`finance_account_access`)
 * or `finance.admin` — the same rule as listAccounts. An `accounts`
 * parameter narrows the scope, but never beyond what the ACL allows: an
 * id the caller may not read is dropped silently rather than erroring, so
 * a shared link with a stale id still renders.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import {
  documents,
  financeDepotDocumentIgnore,
  financeDepotTransactionDocument,
  financeAccount,
  financeAccountAccess,
  financeAccountHolding,
  financeAccountType,
  financeDepotSecurity,
  financeDepotTransaction,
  financeDocumentSettlementLlm,
  financeDocumentStatementLlm,
  financeDocumentPaperLlm,
  users,
} from "../db/schema";
import { deriveDepotTransactionsForBankcontact } from "./depot-derivation";
import { dedupeSnapshotRows, securityIdentity, type SecurityIdentity } from "./security-identity";
import { closesAfter, latestQuotes, quoteDay, quoteFitsCurrency, type StoredQuote } from "./quote-store";
import {
  buyCost,
  computeCostBasis,
  computeRealizedForPosition,
  type CostBasisSource,
  type WacIndex,
} from "./holdings";
import {
  documentIdsByDepotTransaction,
  enrichDocument,
  enrichPendingDocuments,
  correctMisbookedAccumulation,
  findMisbookedAccumulations,
  type MisbookedAccumulation,
  setIgnoredForDepots,
  type EnrichResult,
  type EnrichStats,
} from "./depot-document-enrichment";
import { reconcileHoldings, type HoldingGap } from "./depot-holding-reconciliation";
import { enrichPendingStatements, readDepotStatement, type StatementStats } from "./depot-statement-enrichment";
import { classifyPendingPapers } from "./depot-paper-type";
import {
  bankHolding,
  bankHolds,
  decideSecurity,
  evidenceDocumentIds,
  findSecurity,
  listSecurities,
  removalPreview,
  removeSecurity,
  type ListedSecurity,
  type SecurityStatus,
} from "./depot-securities";
import { cleanSecurityName, isPersonName, paperTypeOf, type PaperType } from "./depot-settlement-parser";
import { readSettlement, rereadAgainstBooking, rejectedAsOtherPaper, type LlmStatus } from "./depot-settlement-reader";
import type { CheckName, FieldSource, MergeField } from "./depot-settlement-merge";

console.log("[boot] finance/portfolio.ts: all imports resolved");

// ----------------------------------------------------------------------
// Scope: which depots the caller may see
// ----------------------------------------------------------------------

export interface DepotAccount {
  id: number;
  label: string;
  currency_code: string;
  /** The account is closed (sold out / moved away); left out of the default scope. */
  closed: boolean;
}

function hasAdmin(auth: { permissions: string[] }): boolean {
  return auth.permissions.includes("finance.admin");
}

/**
 * Every depot account the caller may read, optionally narrowed to the
 * ids in `requested`. Ids outside the readable set are ignored.
 */
export async function visibleDepots(
  auth: { userID: string; permissions: string[] },
  requested: number[] | null,
): Promise<DepotAccount[]> {
  const conditions = [eq(financeAccountType.kind, "depot")];
  if (requested && requested.length > 0) {
    conditions.push(inArray(financeAccount.id, requested));
  }

  const base = db
    .select({
      id: financeAccount.id,
      label: financeAccount.label,
      currency_code: financeAccount.currency_code,
      closed: sql<boolean>`${financeAccount.closed_at} IS NOT NULL`,
    })
    .from(financeAccount)
    .innerJoin(financeAccountType, eq(financeAccountType.id, financeAccount.type_id));

  const rows = hasAdmin(auth)
    ? await base.where(and(...conditions)).orderBy(asc(financeAccount.label))
    : await base
        .innerJoin(
          financeAccountAccess,
          and(
            eq(financeAccountAccess.account_id, financeAccount.id),
            eq(financeAccountAccess.user_id, Number(auth.userID)),
          ),
        )
        .where(and(...conditions))
        .orderBy(asc(financeAccount.label));

  return rows;
}

/**
 * The depots among `visibleDepots` the caller may write to: every one for
 * an admin, otherwise those with `level='write'` on the ACL.
 */
async function writableDepots(
  auth: { userID: string; permissions: string[] },
  requested: number[] | null,
): Promise<DepotAccount[]> {
  const visible = await visibleDepots(auth, requested);
  if (hasAdmin(auth) || visible.length === 0) return visible;
  const rows = await db
    .select({ account_id: financeAccountAccess.account_id })
    .from(financeAccountAccess)
    .where(
      and(
        eq(financeAccountAccess.user_id, Number(auth.userID)),
        eq(financeAccountAccess.level, "write"),
        inArray(financeAccountAccess.account_id, visible.map((d) => d.id)),
      ),
    );
  const writable = new Set(rows.map((r) => r.account_id));
  return visible.filter((d) => writable.has(d.id));
}

/**
 * The depots a portfolio view covers: the requested ones, or else every
 * open depot — closed ones only with `includeClosed`. A closed depot asked
 * for by id is covered; the user picked it on purpose.
 */
function scopeDepots(
  all: DepotAccount[],
  requested: number[] | null,
  includeClosed: boolean,
): DepotAccount[] {
  if (requested && requested.length > 0) return all.filter((d) => requested.includes(d.id));
  return includeClosed ? all : all.filter((d) => !d.closed);
}

/** The depots among `depots` with at least one holding snapshot or one transaction. */
async function withData(depots: DepotAccount[]): Promise<DepotAccount[]> {
  if (depots.length === 0) return depots;
  const ids = depots.map((d) => d.id);
  const [held, traded] = await Promise.all([
    db
      .selectDistinct({ id: financeAccountHolding.account_id })
      .from(financeAccountHolding)
      .where(inArray(financeAccountHolding.account_id, ids)),
    db
      .selectDistinct({ id: financeDepotTransaction.account_id })
      .from(financeDepotTransaction)
      .where(inArray(financeDepotTransaction.account_id, ids)),
  ]);
  const used = new Set([...held, ...traded].map((r) => r.id));
  return depots.filter((d) => used.has(d.id));
}

/** "1,2,3" → [1, 2, 3]; anything that is not a positive integer is an error. */
function parseAccountIds(raw: string | undefined): number[] | null {
  if (!raw || raw.trim() === "") return null;
  const ids = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const parsed: number[] = [];
  for (const s of ids) {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) {
      throw APIError.invalidArgument(`accounts must be a comma-separated list of ids`);
    }
    parsed.push(n);
  }
  return parsed;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDate(raw: string | undefined, field: string): string | null {
  if (!raw) return null;
  if (!ISO_DATE_RE.test(raw)) {
    throw APIError.invalidArgument(`${field} must be YYYY-MM-DD`);
  }
  return raw;
}

function positionKey(r: {
  isin: string | null;
  wkn: string | null;
  name: string | null;
}): string {
  return r.isin || r.wkn || r.name || "";
}

function num(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function yearOf(date: string): number | null {
  if (!date || date.length < 4) return null;
  const y = Number(date.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}

// ----------------------------------------------------------------------
// Portfolio (summary + positions + per-year figures)
// ----------------------------------------------------------------------

export interface PortfolioPosition {
  /** COALESCE(isin, wkn, name) — stable identity across depots. */
  key: string;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  currency: string | null;
  /** Depots that hold or held this position. */
  account_ids: number[];
  /** False when no depot currently holds it (sold out / transferred). */
  open: boolean;
  /** Sum of the current amounts across depots (scale 8). */
  amount: string | null;
  /**
   * The current price (scale 6): the newest stored quote when it is not
   * older than the bank's snapshot and in the position's currency, else
   * the latest price seen in any depot's snapshot.
   */
  price: string | null;
  /** Date of that price. */
  price_as_of: string | null;
  /** Where the price comes from: the quote provider or the bank's snapshot. */
  price_source: "quote" | "bank" | null;
  /** When the quote was priced (ISO timestamp); null for the bank's price. */
  price_at: string | null;
  /**
   * Current value (scale 2): amount × the quote when the price is a
   * quote, else the sum of the depots' snapshot values.
   */
  value: string | null;
  /** Sum of the cost bases across depots (scale 2); null when unknown. */
  cost_basis: string | null;
  /** Per-unit cost basis = cost_basis / amount (scale 6). */
  cost_basis_per_unit: string | null;
  /** "bank" when every depot reported an Einstandskurs, else "tx-wac", else null. */
  cost_basis_source: CostBasisSource;
  unrealized_gain: string | null;
  unrealized_gain_pct: string | null;
  /** Share of the position's value in the portfolio's market value (scale 2, %). */
  weight_pct: string | null;
  /** Sum of realized G/L from sells (scale 2); null when no sell contributed. */
  realized_gain: string | null;
  realized_gain_complete: boolean;
  /** Net dividends / distributions received (scale 2); null when none. */
  income: string | null;
  /** income / cost_basis × 100 (scale 2); null when either is unknown. */
  yield_on_cost_pct: string | null;
  /** Sum of `fees` over every transaction of the position (scale 2). */
  fees: string | null;
  /** Sum of `tax` over every transaction of the position (scale 2). */
  taxes: string | null;
  /** unrealized + realized + income (scale 2); null when nothing is known. */
  total_return: string | null;
  /** total_return / cost_basis × 100 (scale 2). */
  total_return_pct: string | null;
  buy_count: number;
  sell_count: number;
  dividend_count: number;
  first_transaction_at: string | null;
  last_transaction_at: string | null;
}

export interface PortfolioYear {
  year: number;
  realized: string;
  sell_count: number;
  realized_complete: boolean;
  income: string;
  dividend_count: number;
  fees: string;
  taxes: string;
  /** Net invested that year: buys − sells by net amount (scale 2). */
  net_invested: string;
}

export interface PortfolioSummary {
  /** Date of the newest snapshot across the depots; null without snapshots. */
  as_of: string | null;
  /** Date of the newest price of an open position (quote or snapshot). */
  price_as_of: string | null;
  /** When the newest quote used was priced; null when every price is the bank's. */
  quotes_at: string | null;
  market_value: string;
  /** Sum of the cost bases of the open positions that have one. */
  cost_basis: string;
  /** True when every open position has a cost basis. */
  cost_basis_complete: boolean;
  unrealized_gain: string;
  unrealized_gain_pct: string | null;
  realized_gain: string;
  realized_gain_ytd: string;
  realized_gain_complete: boolean;
  income: string;
  income_ytd: string;
  fees: string;
  taxes: string;
  /** unrealized + realized + income. */
  total_return: string;
  total_return_pct: string | null;
  open_positions: number;
  closed_positions: number;
  transaction_count: number;
}

interface PortfolioParams {
  /** Comma-separated depot account ids; omitted = every open readable depot. */
  accounts?: string;
  /** Include closed depots when no `accounts` are given. */
  closed?: boolean;
}

interface PortfolioResponse {
  /** Every readable depot with data, closed ones flagged — for the selector. */
  accounts: DepotAccount[];
  /** Closed depots left out of this view because `closed` was not set. */
  closed_hidden: number;
  currency: string;
  /** True when the depots in scope use more than one currency; sums are then nominal. */
  mixed_currency: boolean;
  summary: PortfolioSummary;
  positions: PortfolioPosition[];
  years: PortfolioYear[];
}

interface DepotTxRow {
  id: number;
  account_id: number;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  kind: string;
  executed_at: string;
  amount: string | null;
  price: string | null;
  gross_amount: string | null;
  fees: string | null;
  tax: string | null;
  net_amount: string | null;
  currency: string | null;
  source: string;
  linked_transaction_id: number | null;
  note: string | null;
}

export interface HoldingRow {
  account_id: number;
  as_of: string;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  amount: string | null;
  price: string | null;
  value: string | null;
  currency: string | null;
  acquisition_price: string | null;
}

/** Mutable accumulator per position while the rows are folded in. */
interface PositionAcc {
  key: string;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  /** The name came from a bank holding, which no transaction's name replaces. */
  nameFromHolding: boolean;
  currency: string | null;
  accountIds: Set<number>;
  open: boolean;
  amount: number;
  price: number | null;
  priceAsOf: string | null;
  /** The quote's timestamp when the price is a quote. */
  priceAt: string | null;
  value: number;
  hasValue: boolean;
  costBasis: number;
  /** False once a holding in any depot has no cost basis. */
  costComplete: boolean;
  /** Number of holdings with each source, to pick the position's label. */
  costSources: Set<CostBasisSource>;
  holdingCount: number;
  realized: number;
  realizedHasData: boolean;
  realizedComplete: boolean;
  income: number;
  hasIncome: boolean;
  fees: number;
  taxes: number;
  buyCount: number;
  sellCount: number;
  dividendCount: number;
  first: string | null;
  last: string | null;
}

function newAcc(key: string): PositionAcc {
  return {
    key,
    isin: null,
    wkn: null,
    name: null,
    nameFromHolding: false,
    currency: null,
    accountIds: new Set(),
    open: false,
    amount: 0,
    price: null,
    priceAsOf: null,
    priceAt: null,
    value: 0,
    hasValue: false,
    costBasis: 0,
    costComplete: true,
    costSources: new Set(),
    holdingCount: 0,
    realized: 0,
    realizedHasData: false,
    realizedComplete: true,
    income: 0,
    hasIncome: false,
    fees: 0,
    taxes: 0,
    buyCount: 0,
    sellCount: 0,
    dividendCount: 0,
    first: null,
    last: null,
  };
}

/**
 * The names of the people using this installation. A security name read
 * off a document that is one of them came from the address block.
 */
async function householdNames(): Promise<string[]> {
  const rows = await db.select({ name: users.name }).from(users);
  return rows.map((r) => r.name).filter((n) => n.trim().length > 0);
}

/**
 * A name read off a document, fit to show: without the table columns
 * around it, and null when it is a label or a person's name.
 */
export function securityDisplayName(name: string | null, people: readonly string[]): string | null {
  if (!name) return null;
  const cleaned = cleanSecurityName(name);
  return cleaned && !isPersonName(cleaned, people) ? cleaned : null;
}

/**
 * The bank's own holding names the security; a transaction's name (read off
 * a document, often enough off the wrong line) only stands in when no
 * holding does, and the first fit one wins.
 */
function adoptIdentity(
  acc: PositionAcc,
  r: { isin: string | null; wkn: string | null; name: string | null; currency: string | null },
  from: "holding" | "transaction",
  people: readonly string[],
) {
  if (r.isin && !acc.isin) acc.isin = r.isin;
  if (r.wkn && !acc.wkn) acc.wkn = r.wkn;
  if (from === "holding" ? r.name && !acc.nameFromHolding : !acc.name) {
    const name = from === "holding" ? r.name : securityDisplayName(r.name, people);
    if (name) {
      acc.name = name;
      if (from === "holding") acc.nameFromHolding = true;
    }
  }
  if (r.currency && !acc.currency) acc.currency = r.currency;
}

/**
 * Latest snapshot per depot: the newest `as_of` of each account, then
 * every holding row of that day. One query per account keeps it simple;
 * a household has a handful of depots, not hundreds.
 */
export async function latestHoldings(accountIds: number[], identity?: SecurityIdentity): Promise<HoldingRow[]> {
  const ident = identity ?? (await securityIdentity());
  const out: HoldingRow[] = [];
  for (const id of accountIds) {
    const [latest] = await db
      .select({ as_of: financeAccountHolding.as_of })
      .from(financeAccountHolding)
      .where(eq(financeAccountHolding.account_id, id))
      .orderBy(desc(financeAccountHolding.as_of))
      .limit(1);
    if (!latest) continue;
    const rows = await db
      .select({
        account_id: financeAccountHolding.account_id,
        as_of: financeAccountHolding.as_of,
        isin: financeAccountHolding.isin,
        wkn: financeAccountHolding.wkn,
        name: financeAccountHolding.name,
        amount: financeAccountHolding.amount,
        price: financeAccountHolding.price,
        value: financeAccountHolding.value,
        currency: financeAccountHolding.currency,
        acquisition_price: financeAccountHolding.acquisition_price,
        source: financeAccountHolding.source,
      })
      .from(financeAccountHolding)
      .where(
        and(
          eq(financeAccountHolding.account_id, id),
          eq(financeAccountHolding.as_of, latest.as_of),
        ),
      );
    // One identity per security, whichever identifier the row carries.
    out.push(...dedupeSnapshotRows(rows.map((r) => ident.complete(r))).map(({ source: _source, ...r }) => r));
  }
  return out;
}

/**
 * WAC per account from its buys — the same index holdings.ts builds, but
 * from rows already in memory so the transactions are read once.
 */
function wacIndexFromRows(txs: DepotTxRow[]): WacIndex {
  const byIsin = new Map<string, { weightedCost: number; totalQty: number }>();
  const byWkn = new Map<string, { weightedCost: number; totalQty: number }>();
  for (const tx of txs) {
    if (tx.kind !== "buy") continue;
    const bought = buyCost(tx);
    if (!bought) continue;
    const { qty, cost } = bought;
    if (tx.isin) {
      const agg = byIsin.get(tx.isin) ?? { weightedCost: 0, totalQty: 0 };
      agg.weightedCost += cost;
      agg.totalQty += qty;
      byIsin.set(tx.isin, agg);
    }
    if (tx.wkn) {
      const agg = byWkn.get(tx.wkn) ?? { weightedCost: 0, totalQty: 0 };
      agg.weightedCost += cost;
      agg.totalQty += qty;
      byWkn.set(tx.wkn, agg);
    }
  }
  return { byIsin, byWkn };
}

function dateOnly(raw: string): string {
  return raw.length > 10 ? raw.slice(0, 10) : raw;
}

/** Signed cash of a tax row (Thesaurierung, Vorabpauschale): always negative. */
function accumulationTax(tx: DepotTxRow): number | null {
  const net = num(tx.net_amount);
  if (net !== null) return -Math.abs(net);
  const tax = num(tx.tax);
  return tax === null ? null : -Math.abs(tax);
}

/** Signed net of a dividend row: net_amount first, gross − fees − tax as the fallback. */
function dividendNet(tx: DepotTxRow): number | null {
  const net = num(tx.net_amount);
  if (net !== null) return net;
  const gross = num(tx.gross_amount);
  if (gross === null) return null;
  return gross - (num(tx.fees) ?? 0) - (num(tx.tax) ?? 0);
}

/** Cash moved for a buy/sell: net first, then gross, then amount × price. */
function cashOf(tx: DepotTxRow): number | null {
  const net = num(tx.net_amount);
  if (net !== null) return Math.abs(net);
  const gross = num(tx.gross_amount);
  if (gross !== null) return Math.abs(gross);
  const a = num(tx.amount);
  const p = num(tx.price);
  if (a === null || p === null) return null;
  return Math.abs(a * p);
}

export function buildPortfolio(
  holdings: HoldingRow[],
  txs: DepotTxRow[],
  /** Names a security can never have (see householdNames). */
  people: readonly string[] = [],
  /** The newest stored quote per position key (see latestQuotes). */
  quotes: ReadonlyMap<string, StoredQuote> = new Map(),
): Pick<PortfolioResponse, "summary" | "positions" | "years"> {
  const positions = new Map<string, PositionAcc>();
  const acc = (key: string) => {
    let p = positions.get(key);
    if (!p) {
      p = newAcc(key);
      positions.set(key, p);
    }
    return p;
  };

  // Transactions per account, for the WAC index and the realized walk.
  const txsByAccount = new Map<number, DepotTxRow[]>();
  for (const tx of txs) {
    const list = txsByAccount.get(tx.account_id) ?? [];
    list.push(tx);
    txsByAccount.set(tx.account_id, list);
  }
  const wacByAccount = new Map<number, WacIndex>();
  for (const [id, list] of txsByAccount) wacByAccount.set(id, wacIndexFromRows(list));

  // 1. Holdings → open positions with value and cost basis.
  let asOf: string | null = null;
  for (const h of holdings) {
    const key = positionKey(h);
    if (!key) continue;
    const day = dateOnly(h.as_of);
    if (!asOf || day > asOf) asOf = day;

    const p = acc(key);
    adoptIdentity(p, h, "holding", people);
    p.accountIds.add(h.account_id);
    p.holdingCount += 1;

    const amount = num(h.amount);
    if (amount !== null && amount > 0) {
      p.open = true;
      p.amount += amount;
    }
    const value = num(h.value);
    if (value !== null) {
      p.value += value;
      p.hasValue = true;
    }
    const price = num(h.price);
    if (price !== null && (!p.priceAsOf || day >= p.priceAsOf)) {
      p.price = price;
      p.priceAsOf = day;
    }

    const wac = wacByAccount.get(h.account_id) ?? { byIsin: new Map(), byWkn: new Map() };
    const valuation = computeCostBasis(h, wac);
    if (valuation.costBasisTotal !== null) {
      p.costBasis += Number(valuation.costBasisTotal);
      p.costSources.add(valuation.source);
    } else if (amount !== null && amount > 0) {
      p.costComplete = false;
    }
  }

  // 1b. Today's price: a quote not older than the snapshot values the
  // shares held instead of the bank's price, which is yesterday's at best.
  for (const p of positions.values()) {
    if (!p.open || p.amount <= 0) continue;
    const q = quotes.get(p.key);
    if (!q || !quoteFitsCurrency(q.currency, p.currency)) continue;
    const day = quoteDay(q.at);
    if (p.priceAsOf && day < p.priceAsOf) continue;
    p.price = q.price;
    p.priceAsOf = day;
    p.priceAt = q.at;
    p.value = p.amount * q.price;
    p.hasValue = true;
  }

  // 2. Transactions → realized, income, fees, taxes, counts, years.
  const years = new Map<
    number,
    {
      realized: number;
      sellCount: number;
      realizedComplete: boolean;
      income: number;
      dividendCount: number;
      fees: number;
      taxes: number;
      netInvested: number;
    }
  >();
  const yearBucket = (y: number) => {
    let b = years.get(y);
    if (!b) {
      b = {
        realized: 0,
        sellCount: 0,
        realizedComplete: true,
        income: 0,
        dividendCount: 0,
        fees: 0,
        taxes: 0,
        netInvested: 0,
      };
      years.set(y, b);
    }
    return b;
  };

  for (const tx of txs) {
    const key = positionKey(tx);
    if (!key) continue;
    const p = acc(key);
    adoptIdentity(p, tx, "transaction", people);
    p.accountIds.add(tx.account_id);

    const day = dateOnly(tx.executed_at);
    if (!p.first || day < p.first) p.first = day;
    if (!p.last || day > p.last) p.last = day;
    const year = yearOf(day);
    const yb = year === null ? null : yearBucket(year);

    const fees = num(tx.fees);
    if (fees !== null) {
      p.fees += Math.abs(fees);
      if (yb) yb.fees += Math.abs(fees);
    }
    // Taxes are kept signed: withheld positive, refunded negative.
    const tax = num(tx.tax);
    if (tax !== null) {
      p.taxes += tax;
      if (yb) yb.taxes += tax;
    }

    if (tx.kind === "buy") {
      p.buyCount += 1;
      const cash = cashOf(tx);
      if (cash !== null && yb) yb.netInvested += cash;
    } else if (tx.kind === "sell") {
      p.sellCount += 1;
      const cash = cashOf(tx);
      if (cash !== null && yb) yb.netInvested -= cash;
    } else if (tx.kind === "dividend") {
      p.dividendCount += 1;
      const net = dividendNet(tx);
      if (net !== null) {
        p.income += net;
        p.hasIncome = true;
        if (yb) {
          yb.income += net;
          yb.dividendCount += 1;
        }
      }
    } else if (tx.kind === "tax") {
      // Tax on income a fund kept: income is counted after taxes, so this
      // lowers it — there was no payout to count.
      const net = accumulationTax(tx);
      if (net !== null) {
        p.income += net;
        p.hasIncome = true;
        if (yb) yb.income += net;
      }
    }
  }

  // Realized G/L: per account and position, so a lot never crosses depots.
  for (const [, list] of txsByAccount) {
    const byKey = new Map<string, DepotTxRow[]>();
    for (const tx of list) {
      const key = positionKey(tx);
      if (!key) continue;
      const bucket = byKey.get(key) ?? [];
      bucket.push(tx);
      byKey.set(key, bucket);
    }
    for (const [key, bucket] of byKey) {
      const r = computeRealizedForPosition(bucket);
      const p = acc(key);
      if (!r.complete) p.realizedComplete = false;
      if (r.hasData) {
        p.realized += r.realized;
        p.realizedHasData = true;
      }
      for (const [year, yr] of r.byYear) {
        const yb = yearBucket(year);
        yb.realized += yr.realized;
        yb.sellCount += yr.sellCount;
        if (!r.complete) yb.realizedComplete = false;
      }
    }
  }

  // 3. Totals and the response shape.
  let marketValue = 0;
  let costBasis = 0;
  let costComplete = true;
  let realized = 0;
  let realizedComplete = true;
  let income = 0;
  let fees = 0;
  let taxes = 0;
  let openCount = 0;
  let closedCount = 0;
  let priceAsOf: string | null = null;
  let quotesAt: string | null = null;

  for (const p of positions.values()) {
    if (p.open) {
      openCount += 1;
      if (p.priceAsOf && (!priceAsOf || p.priceAsOf > priceAsOf)) priceAsOf = p.priceAsOf;
      if (p.priceAt && (!quotesAt || p.priceAt > quotesAt)) quotesAt = p.priceAt;
      marketValue += p.value;
      if (p.costComplete && p.costSources.size > 0) costBasis += p.costBasis;
      else costComplete = false;
    } else {
      closedCount += 1;
    }
    realized += p.realized;
    if (!p.realizedComplete) realizedComplete = false;
    income += p.income;
    fees += p.fees;
    taxes += p.taxes;
  }

  const out: PortfolioPosition[] = [];
  for (const p of positions.values()) {
    const hasCost = p.open && p.costComplete && p.costSources.size > 0;
    const cost = hasCost ? p.costBasis : null;
    const unrealized = p.open && hasCost && p.hasValue ? p.value - p.costBasis : null;
    const realizedOut = p.realizedHasData ? p.realized : null;
    const incomeOut = p.hasIncome ? p.income : null;
    const totalReturn =
      unrealized === null && realizedOut === null && incomeOut === null
        ? null
        : (unrealized ?? 0) + (realizedOut ?? 0) + (incomeOut ?? 0);
    const source: CostBasisSource = !hasCost
      ? null
      : p.costSources.size === 1 && p.costSources.has("bank")
        ? "bank"
        : "tx-wac";

    out.push({
      key: p.key,
      isin: p.isin,
      wkn: p.wkn,
      name: p.name,
      currency: p.currency,
      account_ids: [...p.accountIds].sort((a, b) => a - b),
      open: p.open,
      amount: p.open ? p.amount.toFixed(8) : null,
      price: p.price === null ? null : p.price.toFixed(6),
      price_as_of: p.priceAsOf,
      price_source: p.price === null ? null : p.priceAt ? "quote" : "bank",
      price_at: p.priceAt,
      value: p.open && p.hasValue ? p.value.toFixed(2) : null,
      cost_basis: cost === null ? null : cost.toFixed(2),
      cost_basis_per_unit:
        cost === null || p.amount <= 0 ? null : (cost / p.amount).toFixed(6),
      cost_basis_source: source,
      unrealized_gain: unrealized === null ? null : unrealized.toFixed(2),
      unrealized_gain_pct:
        unrealized === null || cost === null || cost === 0
          ? null
          : ((unrealized / cost) * 100).toFixed(2),
      weight_pct:
        p.open && p.hasValue && marketValue > 0
          ? ((p.value / marketValue) * 100).toFixed(2)
          : null,
      realized_gain: realizedOut === null ? null : realizedOut.toFixed(2),
      realized_gain_complete: p.realizedComplete,
      income: incomeOut === null ? null : incomeOut.toFixed(2),
      yield_on_cost_pct:
        incomeOut === null || cost === null || cost === 0
          ? null
          : ((incomeOut / cost) * 100).toFixed(2),
      fees: p.fees > 0 ? p.fees.toFixed(2) : null,
      taxes: p.taxes !== 0 ? p.taxes.toFixed(2) : null,
      total_return: totalReturn === null ? null : totalReturn.toFixed(2),
      total_return_pct:
        totalReturn === null || cost === null || cost === 0
          ? null
          : ((totalReturn / cost) * 100).toFixed(2),
      buy_count: p.buyCount,
      sell_count: p.sellCount,
      dividend_count: p.dividendCount,
      first_transaction_at: p.first,
      last_transaction_at: p.last,
    });
  }

  // Open positions by value, then closed ones by name.
  out.sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    if (a.open) {
      const av = a.value === null ? -1 : Number(a.value);
      const bv = b.value === null ? -1 : Number(b.value);
      if (av !== bv) return bv - av;
    }
    const an = (a.name ?? a.key).toLowerCase();
    const bn = (b.name ?? b.key).toLowerCase();
    return an.localeCompare(bn);
  });

  const unrealizedTotal = marketValue - costBasis;
  const totalReturn = unrealizedTotal + realized + income;
  const thisYear = new Date().getFullYear();
  const ytd = years.get(thisYear);

  const yearsOut: PortfolioYear[] = [...years.entries()]
    .sort(([a], [b]) => b - a)
    .map(([year, b]) => ({
      year,
      realized: b.realized.toFixed(2),
      sell_count: b.sellCount,
      realized_complete: b.realizedComplete,
      income: b.income.toFixed(2),
      dividend_count: b.dividendCount,
      fees: b.fees.toFixed(2),
      taxes: b.taxes.toFixed(2),
      net_invested: b.netInvested.toFixed(2),
    }));

  return {
    summary: {
      as_of: asOf,
      price_as_of: priceAsOf,
      quotes_at: quotesAt,
      market_value: marketValue.toFixed(2),
      cost_basis: costBasis.toFixed(2),
      cost_basis_complete: costComplete,
      unrealized_gain: unrealizedTotal.toFixed(2),
      unrealized_gain_pct:
        costBasis > 0 ? ((unrealizedTotal / costBasis) * 100).toFixed(2) : null,
      realized_gain: realized.toFixed(2),
      realized_gain_ytd: (ytd?.realized ?? 0).toFixed(2),
      realized_gain_complete: realizedComplete,
      income: income.toFixed(2),
      income_ytd: (ytd?.income ?? 0).toFixed(2),
      fees: fees.toFixed(2),
      taxes: taxes.toFixed(2),
      total_return: totalReturn.toFixed(2),
      total_return_pct:
        costBasis > 0 ? ((totalReturn / costBasis) * 100).toFixed(2) : null,
      open_positions: openCount,
      closed_positions: closedCount,
      transaction_count: txs.length,
    },
    positions: out,
    years: yearsOut,
  };
}

async function loadTransactions(accountIds: number[], identity?: SecurityIdentity): Promise<DepotTxRow[]> {
  if (accountIds.length === 0) return [];
  const ident = identity ?? (await securityIdentity());
  const rows = await db
    .select({
      id: financeDepotTransaction.id,
      account_id: financeDepotTransaction.account_id,
      isin: financeDepotTransaction.isin,
      wkn: financeDepotTransaction.wkn,
      name: financeDepotTransaction.name,
      kind: financeDepotTransaction.kind,
      executed_at: financeDepotTransaction.executed_at,
      amount: financeDepotTransaction.amount,
      price: financeDepotTransaction.price,
      gross_amount: financeDepotTransaction.gross_amount,
      fees: financeDepotTransaction.fees,
      tax: financeDepotTransaction.tax,
      net_amount: financeDepotTransaction.net_amount,
      currency: financeDepotTransaction.currency,
      source: financeDepotTransaction.source,
      linked_transaction_id: financeDepotTransaction.linked_transaction_id,
      note: financeDepotTransaction.note,
    })
    .from(financeDepotTransaction)
    .where(inArray(financeDepotTransaction.account_id, accountIds));
  return rows.map((r) => ident.complete(r));
}

/** The keys the quotes are kept under: the held securities with an ISIN or WKN. */
function quotedKeys(holdings: HoldingRow[]): string[] {
  const keys = new Set<string>();
  for (const h of holdings) {
    const key = h.isin || h.wkn;
    if (key && Number(h.amount) > 0) keys.add(key);
  }
  return [...keys];
}

function scopeCurrency(accounts: DepotAccount[]): { currency: string; mixed: boolean } {
  const codes = new Set(accounts.map((a) => a.currency_code));
  if (codes.size === 0) return { currency: "EUR", mixed: false };
  return { currency: accounts[0].currency_code, mixed: codes.size > 1 };
}

export const getPortfolio = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/portfolio",
    auth: true,
  },
  async ({ accounts, closed }: PortfolioParams): Promise<PortfolioResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const requested = parseAccountIds(accounts);
    // The selector offers every readable depot even when the scope is
    // narrowed — but only depots that have ever held or traded anything:
    // a bank's empty sub-depots and accounts typed "depot" by mistake
    // would otherwise inflate "n Depots" and the selector.
    const allDepots = await withData(await visibleDepots(auth, null));
    const depots = scopeDepots(allDepots, requested, closed === true);
    const ids = depots.map((d) => d.id);
    const closedHidden =
      requested && requested.length > 0
        ? 0
        : allDepots.filter((d) => d.closed && !depots.includes(d)).length;

    const identity = await securityIdentity();
    const [holdings, txs, people] = await Promise.all([
      latestHoldings(ids, identity),
      loadTransactions(ids, identity),
      householdNames(),
    ]);
    const { currency, mixed } = scopeCurrency(depots);
    const quotes = await latestQuotes(quotedKeys(holdings));

    return {
      accounts: allDepots,
      closed_hidden: closedHidden,
      currency,
      mixed_currency: mixed,
      ...buildPortfolio(holdings, txs, people, quotes),
    };
  },
);

// ----------------------------------------------------------------------
// Transactions across depots
// ----------------------------------------------------------------------

export interface PortfolioTransaction {
  id: number;
  account_id: number;
  account_label: string;
  /** COALESCE(isin, wkn, name) — links the row to its position. */
  position_key: string;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  kind: string;
  executed_at: string;
  amount: string | null;
  price: string | null;
  gross_amount: string | null;
  fees: string | null;
  tax: string | null;
  net_amount: string | null;
  currency: string | null;
  source: string;
  linked_transaction_id: number | null;
  note: string | null;
  /** Settlement documents this row was read from or confirmed by. */
  document_ids: number[];
}

type TxSortField = "executed_at" | "net_amount" | "name";

interface PortfolioTransactionsParams {
  /** Comma-separated depot account ids; omitted = every open readable depot. */
  accounts?: string;
  /** Include closed depots when no `accounts` are given. */
  closed?: boolean;
  /** Position key (isin, wkn or name) to narrow to one security. */
  position?: string;
  /** buy | sell | in | out | dividend | split | corp_action */
  kind?: string;
  /** Case-insensitive substring over name, isin and wkn. */
  q?: string;
  /** YYYY-MM-DD inclusive bounds on executed_at. */
  from?: string;
  to?: string;
  sortBy?: TxSortField;
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

interface PortfolioTransactionsResponse {
  items: PortfolioTransaction[];
  total: number;
  /** Sums over the whole filtered set, not just this page (scale 2). */
  sums: {
    net_amount: string;
    fees: string;
    taxes: string;
  };
}

const VALID_KINDS = new Set(["buy", "sell", "in", "out", "dividend", "split", "corp_action", "tax"]);

export const listPortfolioTransactions = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/portfolio/transactions",
    auth: true,
  },
  async (p: PortfolioTransactionsParams): Promise<PortfolioTransactionsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const requested = parseAccountIds(p.accounts);
    const depots = scopeDepots(await visibleDepots(auth, null), requested, p.closed === true);
    const ids = depots.map((d) => d.id);
    const empty = { items: [], total: 0, sums: { net_amount: "0.00", fees: "0.00", taxes: "0.00" } };
    if (ids.length === 0) return empty;

    const from = normalizeDate(p.from, "from");
    const to = normalizeDate(p.to, "to");
    if (from && to && from > to) {
      throw APIError.invalidArgument("from must be on or before to");
    }
    if (p.kind && !VALID_KINDS.has(p.kind)) {
      throw APIError.invalidArgument(`invalid kind '${p.kind}'`);
    }
    const limit = Math.min(Math.max(p.limit ?? 100, 1), 500);
    const offset = Math.max(p.offset ?? 0, 0);

    const t = financeDepotTransaction;
    const conditions = [inArray(t.account_id, ids)];
    if (p.kind) conditions.push(eq(t.kind, p.kind));
    if (from) conditions.push(sql`${t.executed_at} >= ${from}::date`);
    if (to) conditions.push(sql`${t.executed_at} <= ${to}::date`);
    const identity = await securityIdentity();
    if (p.position) {
      // The key names the security; a row may carry only its other identifier.
      const key = identity.complete({ isin: null, wkn: p.position }).isin ?? p.position;
      const wkns = identity.wknsOf(key);
      conditions.push(
        or(
          eq(t.isin, key),
          and(sql`${t.isin} IS NULL`, eq(t.wkn, key)),
          ...(wkns.length > 0 ? [and(sql`${t.isin} IS NULL`, inArray(t.wkn, wkns))] : []),
          and(sql`${t.isin} IS NULL`, sql`${t.wkn} IS NULL`, eq(t.name, key)),
        )!,
      );
    }
    const q = p.q?.trim();
    if (q) {
      const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      conditions.push(
        or(ilike(t.name, pattern), ilike(t.isin, pattern), ilike(t.wkn, pattern))!,
      );
    }
    const where = and(...conditions);

    const sortField: TxSortField = p.sortBy ?? "executed_at";
    const dir = p.sortDir === "asc" ? asc : desc;
    const orderBy =
      sortField === "net_amount"
        ? [dir(sql`CAST(${t.net_amount} AS NUMERIC)`), desc(t.executed_at), desc(t.id)]
        : sortField === "name"
          ? [dir(sql`COALESCE(${t.name}, ${t.isin}, ${t.wkn})`), desc(t.executed_at), desc(t.id)]
          : [dir(t.executed_at), dir(t.id)];

    const [rows, [agg]] = await Promise.all([
      db
        .select()
        .from(t)
        .where(where)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
      db
        .select({
          total: sql<number>`COUNT(*)::int`,
          net: sql<string>`COALESCE(SUM(CAST(${t.net_amount} AS NUMERIC)), 0)::text`,
          fees: sql<string>`COALESCE(SUM(ABS(CAST(${t.fees} AS NUMERIC))), 0)::text`,
          taxes: sql<string>`COALESCE(SUM(CAST(${t.tax} AS NUMERIC)), 0)::text`,
        })
        .from(t)
        .where(where),
    ]);

    const labelById = new Map(depots.map((d) => [d.id, d.label]));
    const [docsById, people] = await Promise.all([
      documentIdsByDepotTransaction(rows.map((r) => r.id)),
      householdNames(),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        account_id: r.account_id,
        account_label: labelById.get(r.account_id) ?? "",
        position_key: identity.key(r),
        isin: r.isin,
        wkn: r.wkn,
        name: securityDisplayName(r.name, people),
        kind: r.kind,
        executed_at: dateOnly(r.executed_at),
        amount: r.amount,
        price: r.price,
        gross_amount: r.gross_amount,
        fees: r.fees,
        tax: r.tax,
        net_amount: r.net_amount,
        currency: r.currency,
        source: r.source,
        linked_transaction_id: r.linked_transaction_id,
        note: r.note,
        document_ids: docsById.get(r.id) ?? [],
      })),
      total: agg.total,
      sums: {
        net_amount: Number(agg.net).toFixed(2),
        fees: Number(agg.fees).toFixed(2),
        taxes: Number(agg.taxes).toFixed(2),
      },
    };
  },
);

// ----------------------------------------------------------------------
// One position in detail (#1336, stage 3)
//
// Everything the detail page shows for a single security: the aggregated
// position, how it is split across depots, its value/price history as a
// day series summed over the depots, every transaction, each evaluated
// sale with the cost it was matched against, and income per year.
// ----------------------------------------------------------------------

export interface PositionAccountShare {
  account_id: number;
  account_label: string;
  amount: string | null;
  value: string | null;
  cost_basis: string | null;
  cost_basis_source: CostBasisSource;
  as_of: string | null;
}

export interface PositionHistoryPoint {
  as_of: string;
  /** Sum of the amounts held that day across depots (scale 8). */
  amount: string | null;
  /** Last non-null price reported that day (scale 6). */
  price: string | null;
  /** Sum of the values that day (scale 2). */
  value: string | null;
  /** "bank": a snapshot; "quote": a close or today's quote after the last snapshot. */
  source: "bank" | "quote";
}

/**
 * The days after the last snapshot, from the stored closes and ending in
 * the position's current quote, each valued at today's shares. Empty when
 * the position's price is not a quote.
 */
async function quoteHistory(position: PortfolioPosition, lastSnapshot: string | null): Promise<PositionHistoryPoint[]> {
  if (position.price_source !== "quote" || position.price === null || position.price_at === null || position.amount === null) return [];
  const amount = Number(position.amount);
  const point = (as_of: string, price: number): PositionHistoryPoint => ({
    as_of,
    amount: position.amount,
    price: price.toFixed(6),
    value: (amount * price).toFixed(2),
    source: "quote",
  });
  const after = lastSnapshot ?? quoteDay(position.price_at);
  const out = lastSnapshot
    ? (await closesAfter(position.key, after))
        .filter((c) => quoteFitsCurrency(c.currency, position.currency))
        .map((c) => point(c.day, c.price))
    : [];
  // The current price finishes the line: today's close so far, or a new day.
  const today = position.price_as_of!;
  if (lastSnapshot !== null && today <= lastSnapshot) return out;
  const price = Number(position.price);
  if (out.length > 0 && out[out.length - 1]!.as_of === today) out[out.length - 1] = point(today, price);
  else out.push(point(today, price));
  return out;
}

export interface PositionSale {
  transaction_id: number;
  account_id: number;
  executed_at: string;
  quantity: string;
  proceeds: string;
  /** Null when a buy before it has no quantity or price. */
  cost: string | null;
  cost_per_unit: string | null;
  gain: string | null;
}

export interface PositionYear {
  year: number;
  realized: string;
  /** False when a sale that year has unknown costs (left out of `realized`). */
  realized_complete: boolean;
  sell_count: number;
  income: string;
  dividend_count: number;
  fees: string;
  taxes: string;
}

interface PositionParams {
  key: string;
  /** Comma-separated depot account ids; omitted = every open readable depot. */
  accounts?: string;
  /** Include closed depots when no `accounts` are given. */
  closed?: boolean;
}

interface PositionResponse {
  currency: string;
  position: PortfolioPosition;
  accounts: PositionAccountShare[];
  history: PositionHistoryPoint[];
  transactions: PortfolioTransaction[];
  sales: PositionSale[];
  years: PositionYear[];
  /** Share changes between snapshots no transaction accounts for. */
  holding_gaps: HoldingGap[];
  /** Share changes that could not be checked (a transaction lacks its quantity). */
  unverifiable_changes: number;
  /** Per depot: where the security stands in the master, and what taking it out would delete. */
  depots: PositionDepotSecurity[];
}

/** The security in one depot's master, for "Aus Depot entfernen" on the position page. */
export interface PositionDepotSecurity {
  account_id: number;
  /** The master row (`finance_depot_security.id`), what a collection holds (#1548); null without an entry. */
  security_id: number | null;
  account_label: string;
  /** The master's status; null when the depot has no entry (rows from before the master). */
  status: SecurityStatus | null;
  /**
   * The bank's latest snapshot lists it and no newer snapshot of the depot
   * says otherwise: it cannot be removed, the bank would bring it back.
   */
  bank_held: boolean;
  /** Day of the bank's latest snapshot when that lists it — current or outdated by a newer statement. */
  bank_as_of: string | null;
  /** The caller may write to the depot. */
  writable: boolean;
  /** Transactions read from papers or derived from bookings that removing it deletes. */
  removable_transactions: number;
  /** Holdings read from statements that removing it deletes. */
  removable_holdings: number;
}

function matchesKey(
  r: { isin: string | null; wkn: string | null; name: string | null },
  key: string,
): boolean {
  return positionKey(r) === key;
}

export const getPortfolioPosition = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/portfolio/positions/:key",
    auth: true,
  },
  async ({ key: requestedKey, accounts, closed }: PositionParams): Promise<PositionResponse> => {
    const auth = getAuthData()!;
    let key = requestedKey;
    requirePermission(auth, "finance.view");
    if (!key || key.trim() === "") {
      throw APIError.invalidArgument("key is required");
    }

    const depots = scopeDepots(await visibleDepots(auth, null), parseAccountIds(accounts), closed === true);
    const ids = depots.map((d) => d.id);
    if (ids.length === 0) throw APIError.notFound(`position ${key} not found`);

    // The position's figures come from the same fold as the overview, so
    // both pages agree to the cent.
    const identity = await securityIdentity();
    const [holdings, txs, people] = await Promise.all([
      latestHoldings(ids, identity),
      loadTransactions(ids, identity),
      householdNames(),
    ]);
    // A link from before the identifiers were joined may name the WKN, or
    // an ISIN as OCR read it.
    key = identity.key({ isin: /^[A-Z]{2}[A-Z0-9]{10}$/.test(key) ? key : null, wkn: /^[A-Z0-9]{6}$/.test(key) ? key : null, name: key });
    let built = buildPortfolio(holdings, txs, people, await latestQuotes(quotedKeys(holdings)));
    let position = built.positions.find((p) => p.key === key);
    if (!position) {
      // Only in older snapshots (a holding gap links here): no depot holds
      // it now and no transaction names it. Shown as a closed position
      // with its history rather than not found.
      const seen = dedupeSnapshotRows(
        (
          await db
            .select({
              account_id: financeAccountHolding.account_id,
              as_of: financeAccountHolding.as_of,
              isin: financeAccountHolding.isin,
              wkn: financeAccountHolding.wkn,
              name: financeAccountHolding.name,
              amount: financeAccountHolding.amount,
              price: financeAccountHolding.price,
              value: financeAccountHolding.value,
              currency: financeAccountHolding.currency,
              acquisition_price: financeAccountHolding.acquisition_price,
              source: financeAccountHolding.source,
            })
            .from(financeAccountHolding)
            .where(inArray(financeAccountHolding.account_id, ids))
        ).map((r) => identity.complete(r)),
      ).filter((r) => matchesKey(r, key));
      const lastByAccount = new Map<number, (typeof seen)[number]>();
      for (const r of seen) {
        const prev = lastByAccount.get(r.account_id);
        if (!prev || r.as_of > prev.as_of) lastByAccount.set(r.account_id, r);
      }
      const gone: HoldingRow[] = [...lastByAccount.values()].map(({ source: _source, ...r }) => ({ ...r, amount: "0", value: null }));
      if (gone.length > 0) {
        built = buildPortfolio([...holdings, ...gone], txs, people, await latestQuotes(quotedKeys(holdings)));
        position = built.positions.find((p) => p.key === key);
      }
    }
    if (!position) throw APIError.notFound(`position ${key} not found`);

    const labelById = new Map(depots.map((d) => [d.id, d.label]));
    const txsByAccount = new Map<number, DepotTxRow[]>();
    for (const tx of txs) {
      if (!matchesKey(tx, key)) continue;
      const list = txsByAccount.get(tx.account_id) ?? [];
      list.push(tx);
      txsByAccount.set(tx.account_id, list);
    }

    // Per-depot share from the latest snapshot of each depot.
    const shares: PositionAccountShare[] = [];
    for (const h of holdings) {
      if (!matchesKey(h, key)) continue;
      const wac = wacIndexFromRows(txsByAccount.get(h.account_id) ?? []);
      const valuation = computeCostBasis(h, wac);
      shares.push({
        account_id: h.account_id,
        account_label: labelById.get(h.account_id) ?? "",
        amount: h.amount,
        // Valued at the position's price when that is a quote, so the
        // depots add up to the position.
        value:
          position.price_source === "quote" && position.price !== null && num(h.amount) !== null
            ? (num(h.amount)! * Number(position.price)).toFixed(2)
            : h.value,
        cost_basis: valuation.costBasisTotal,
        cost_basis_source: valuation.source,
        as_of: dateOnly(h.as_of),
      });
    }
    shares.sort((a, b) => a.account_label.localeCompare(b.account_label));

    // Day series across depots: every snapshot row of this position.
    const historyRows = await db
      .select({
        account_id: financeAccountHolding.account_id,
        as_of: financeAccountHolding.as_of,
        isin: financeAccountHolding.isin,
        wkn: financeAccountHolding.wkn,
        name: financeAccountHolding.name,
        amount: financeAccountHolding.amount,
        price: financeAccountHolding.price,
        value: financeAccountHolding.value,
        source: financeAccountHolding.source,
      })
      .from(financeAccountHolding)
      .where(inArray(financeAccountHolding.account_id, ids))
      .orderBy(asc(financeAccountHolding.as_of), asc(financeAccountHolding.id))
      .then((rows) => dedupeSnapshotRows(rows.map((r) => identity.complete(r))));
    const byDay = new Map<
      string,
      { amount: number; hasAmount: boolean; value: number; hasValue: boolean; price: number | null }
    >();
    for (const r of historyRows) {
      if (!matchesKey(r, key)) continue;
      const day = dateOnly(r.as_of);
      const d = byDay.get(day) ?? { amount: 0, hasAmount: false, value: 0, hasValue: false, price: null };
      const a = num(r.amount);
      if (a !== null) {
        d.amount += a;
        d.hasAmount = true;
      }
      const v = num(r.value);
      if (v !== null) {
        d.value += v;
        d.hasValue = true;
      }
      const p = num(r.price);
      if (p !== null) d.price = p;
      byDay.set(day, d);
    }
    const history: PositionHistoryPoint[] = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([as_of, d]) => ({
        as_of,
        amount: d.hasAmount ? d.amount.toFixed(8) : null,
        price: d.price === null ? null : d.price.toFixed(6),
        value: d.hasValue ? d.value.toFixed(2) : null,
        source: "bank" as const,
      }));
    history.push(...(await quoteHistory(position, history[history.length - 1]?.as_of ?? null)));

    // Sales, replayed per depot exactly as the realized figure is.
    const sales: PositionSale[] = [];
    for (const [accountId, list] of txsByAccount) {
      computeRealizedForPosition(list, (sale) => {
        sales.push({
          transaction_id: sale.transactionId,
          account_id: accountId,
          executed_at: dateOnly(sale.executedAt),
          quantity: sale.quantity.toFixed(8),
          proceeds: sale.proceeds.toFixed(2),
          cost: sale.cost?.toFixed(2) ?? null,
          cost_per_unit: sale.costPerUnit?.toFixed(6) ?? null,
          gain: sale.gain?.toFixed(2) ?? null,
        });
      });
    }
    sales.sort((a, b) => b.executed_at.localeCompare(a.executed_at) || b.transaction_id - a.transaction_id);

    // Per-year figures of this position alone.
    const years = new Map<number, PositionYear>();
    const yearOfPos = (day: string) => {
      const y = yearOf(day);
      if (y === null) return null;
      let b = years.get(y);
      if (!b) {
        b = { year: y, realized: "0", realized_complete: true, sell_count: 0, income: "0", dividend_count: 0, fees: "0", taxes: "0" };
        years.set(y, b);
      }
      return b;
    };
    const acc = new Map<number, { realized: number; income: number; fees: number; taxes: number }>();
    const accOf = (y: number) => {
      let a = acc.get(y);
      if (!a) {
        a = { realized: 0, income: 0, fees: 0, taxes: 0 };
        acc.set(y, a);
      }
      return a;
    };
    for (const sale of sales) {
      const b = yearOfPos(sale.executed_at);
      if (!b) continue;
      b.sell_count += 1;
      if (sale.gain === null) b.realized_complete = false;
      else accOf(b.year).realized += Number(sale.gain);
    }
    const positionTxs: PortfolioTransaction[] = [];
    for (const [, list] of txsByAccount) {
      for (const tx of list) {
        const day = dateOnly(tx.executed_at);
        const b = yearOfPos(day);
        if (b) {
          const a = accOf(b.year);
          a.fees += Math.abs(num(tx.fees) ?? 0);
          a.taxes += Math.abs(num(tx.tax) ?? 0);
          if (tx.kind === "dividend") {
            const net = dividendNet(tx);
            if (net !== null) {
              a.income += net;
              b.dividend_count += 1;
            }
          } else if (tx.kind === "tax") {
            const net = accumulationTax(tx);
            if (net !== null) a.income += net;
          }
        }
        positionTxs.push({
          id: tx.id,
          account_id: tx.account_id,
          account_label: labelById.get(tx.account_id) ?? "",
          position_key: key,
          isin: tx.isin,
          wkn: tx.wkn,
          name: tx.name,
          kind: tx.kind,
          executed_at: day,
          amount: tx.amount,
          price: tx.price,
          gross_amount: tx.gross_amount,
          fees: tx.fees,
          tax: tx.tax,
          net_amount: tx.net_amount,
          currency: tx.currency,
          source: tx.source,
          linked_transaction_id: tx.linked_transaction_id,
          note: tx.note,
          document_ids: [],
        });
      }
    }
    positionTxs.sort((a, b) => b.executed_at.localeCompare(a.executed_at) || b.id - a.id);
    const positionDocs = await documentIdsByDepotTransaction(positionTxs.map((t) => t.id));
    for (const t of positionTxs) t.document_ids = positionDocs.get(t.id) ?? [];

    const yearsOut = [...years.values()]
      .sort((a, b) => b.year - a.year)
      .map((b) => {
        const a = accOf(b.year);
        return {
          ...b,
          realized: a.realized.toFixed(2),
          income: a.income.toFixed(2),
          fees: a.fees.toFixed(2),
          taxes: a.taxes.toFixed(2),
        };
      });

    const recon = await reconcileHoldings(ids, key);
    const securityDepots = await positionDepotSecurities(auth, position, labelById);

    return {
      currency: scopeCurrency(depots).currency,
      position,
      accounts: shares,
      history,
      transactions: positionTxs,
      sales,
      years: yearsOut,
      holding_gaps: recon.gaps,
      unverifiable_changes: recon.unverifiable,
      depots: securityDepots,
    };
  },
);

async function positionDepotSecurities(
  auth: { userID: string; permissions: string[] },
  position: PortfolioPosition,
  labelById: Map<number, string>,
): Promise<PositionDepotSecurity[]> {
  // Only a security with an identifier can be kept out of a depot.
  if (!position.isin && !position.wkn) return [];
  const ids = { isin: position.isin, wkn: position.wkn };
  const writable = new Set((await writableDepots(auth, position.account_ids)).map((d) => d.id));
  const out: PositionDepotSecurity[] = [];
  for (const accountId of position.account_ids) {
    if (!labelById.has(accountId)) continue;
    const [entry, bank, counts] = await Promise.all([
      findSecurity(accountId, ids),
      bankHolding(accountId, ids),
      removalPreview(accountId, ids),
    ]);
    out.push({
      account_id: accountId,
      security_id: entry?.id != null ? Number(entry.id) : null,
      account_label: labelById.get(accountId) ?? "",
      status: (entry?.status as SecurityStatus | undefined) ?? null,
      bank_held: bank?.current ?? false,
      bank_as_of: bank?.as_of ?? null,
      writable: writable.has(accountId),
      removable_transactions: counts.transactions,
      removable_holdings: counts.holdings,
    });
  }
  return out;
}

interface RemovePositionParams {
  key: string;
  /** The depot to take the security out of. */
  accountId: number;
}

interface RemovePositionResponse {
  security_id: number;
  /** Transactions read from papers or derived from bookings, deleted. */
  transactions_removed: number;
  /** Holdings read from statements, deleted. */
  holdings_removed: number;
}

/**
 * Take a security added by mistake out of a depot (see removeSecurity):
 * ignored from now on, its read and derived rows deleted. Refused while
 * the bank's latest snapshot still lists it — the next sync would bring
 * it back. Write access to the depot is required.
 */
export const removePositionFromDepot = api(
  { expose: true, method: "POST", path: "/finance/portfolio/positions/:key/remove", auth: true },
  async ({ key, accountId }: RemovePositionParams): Promise<RemovePositionResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    if ((await writableDepots(auth, [accountId])).length === 0) {
      throw APIError.permissionDenied("write access to the depot is required");
    }
    const identity = await securityIdentity();
    const [holdings, txs, people] = await Promise.all([
      latestHoldings([accountId], identity),
      loadTransactions([accountId], identity),
      householdNames(),
    ]);
    const position = buildPortfolio(holdings, txs, people).positions.find((p) => p.key === key);
    if (!position) throw APIError.notFound(`position ${key} not found in this depot`);
    if (!position.isin && !position.wkn) {
      throw APIError.failedPrecondition("the position has neither ISIN nor WKN");
    }
    const ids = { isin: position.isin, wkn: position.wkn, name: position.name };
    if (await bankHolds(accountId, ids)) {
      throw APIError.failedPrecondition("the bank still reports this security in the depot");
    }
    const r = await removeSecurity(accountId, ids, Number(auth.userID));
    return { security_id: r.security_id, transactions_removed: r.transactions, holdings_removed: r.holdings };
  },
);

// ----------------------------------------------------------------------
// Read settlement documents into depot transactions (#1336, stage 4)
//
// The same enrichment that runs after a document is classified, on demand
// over every ready settlement that is not linked yet — for a backfill of
// old statements, or after a depot was synced for the first time and the
// holdings that tell a document where it belongs now exist. Only depots
// the caller may write to are touched.
// ----------------------------------------------------------------------

interface EnrichDocumentsParams {
  /** Comma-separated depot account ids; omitted = every writable depot. */
  accounts?: string;
  /** Maximum number of documents examined in this call (default 200). */
  limit?: number;
  /** Continue a run: only documents with an id below this (the previous call's `next_before`). */
  before?: number;
}

interface EnrichDocumentsResponse {
  /** Pass as `before` to examine the next page; null when every pending document was examined. */
  next_before: number | null;
  documents_examined: number;
  created: number;
  enriched: number;
  linked: number;
  already_linked: number;
  skipped_not_settlement: number;
  skipped_no_holding: number;
  conflicts: number;
  unverified: number;
  /** Tax statements without a transaction to add their tax to. */
  skipped_no_transaction: number;
  errors: string[];
  /** Per document: only the ones that changed something or need a look. */
  results: EnrichResult[];
}

/**
 * How long one enrich request may keep starting documents. Reverse proxies
 * commonly cut a request at 60 s; one more document read by the model
 * (seconds, rarely more) has to fit after the budget runs out.
 */
const ENRICH_REQUEST_BUDGET_MS = 20_000;

/** One page of the pending documents of these depots, newest first, below `before`. */
async function enrichPage(depotIds: number[], limit: number, before: number | null) {
  const stats = await enrichPendingDocuments(depotIds, limit, {}, { before, budgetMs: ENRICH_REQUEST_BUDGET_MS });
  if (stats.created > 0) {
    // A new row may be the first trace of a position closed before the
    // first holdings snapshot: its bookings can be derived only now.
    const bankcontacts = await db
      .selectDistinct({ id: financeAccount.bankcontact_id })
      .from(financeAccount)
      .where(inArray(financeAccount.id, depotIds));
    for (const bc of bankcontacts) {
      if (bc.id !== null) await deriveDepotTransactionsForBankcontact(bc.id);
    }
  }
  return stats;
}

export const enrichDepotTransactionsFromDocuments = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/portfolio/documents/enrich",
    auth: true,
  },
  async ({ accounts, limit, before }: EnrichDocumentsParams): Promise<EnrichDocumentsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const depots = await writableDepots(auth, parseAccountIds(accounts));
    if (depots.length === 0) {
      throw APIError.permissionDenied("write access to at least one depot is required");
    }
    const stats = await enrichPage(depots.map((d) => d.id), limit ?? 200, before ?? null);
    return {
      ...stats,
      results: stats.results.filter(
        (r) => r.outcome !== "not_settlement" && r.outcome !== "no_holding",
      ),
    };
  },
);

// ----------------------------------------------------------------------
// Reading the documents in the background
//
// A full read can take minutes when the model reads papers for the first
// time. Driven page by page from the browser it stopped with the tab, and
// a page opened again knew nothing of it. The run lives on the server
// instead: one per user, started by `startDocumentEnrichRun`, followed by
// `documentEnrichRunStatus`. It works page by page as before, so a slow
// model holds up nothing else. The state is kept in memory: a restart of
// the app ends a run, and the next run picks up what is still unlinked.
// ----------------------------------------------------------------------

export interface EnrichRunTotals {
  documents_examined: number;
  created: number;
  enriched: number;
  linked: number;
  conflicts: number;
  unverified: number;
  skipped_no_holding: number;
  skipped_no_transaction: number;
  skipped_unknown_security: number;
  /** Papers the model could not read yet: nothing booked, read again later. */
  waiting_for_model: number;
  /** Depot statements and reportings read into holdings snapshots (stage 2). */
  statements_stored: number;
  /** Statements no depot could be found for — listed on the review page. */
  statements_unplaced: number;
  /** Positions on statements about securities the master has not confirmed: proposed. */
  statement_positions_proposed: number;
  /** Papers the rules did not recognise that the model took for a settlement or a statement (stage 3). */
  papers_recognized: number;
}

export interface EnrichRun {
  id: number;
  status: "running" | "done" | "failed";
  started_at: string;
  finished_at: string | null;
  /** The depots the run reads into. */
  account_ids: number[];
  totals: EnrichRunTotals;
  /** Set when the run failed. */
  error: string | null;
}

const enrichRuns = new Map<number, EnrichRun>();
const enrichRunPromises = new Map<number, Promise<void>>();
let enrichRunSeq = 0;

function emptyTotals(): EnrichRunTotals {
  return {
    documents_examined: 0,
    created: 0,
    enriched: 0,
    linked: 0,
    conflicts: 0,
    unverified: 0,
    skipped_no_holding: 0,
    skipped_no_transaction: 0,
    skipped_unknown_security: 0,
    waiting_for_model: 0,
    statements_stored: 0,
    statements_unplaced: 0,
    statement_positions_proposed: 0,
    papers_recognized: 0,
  };
}

const SETTLEMENT_TOTAL_KEYS = [
  "documents_examined",
  "created",
  "enriched",
  "linked",
  "conflicts",
  "unverified",
  "skipped_no_holding",
  "skipped_no_transaction",
  "skipped_unknown_security",
  "waiting_for_model",
] as const satisfies readonly (keyof EnrichRunTotals & keyof EnrichStats)[];

function addStatementPage(totals: EnrichRunTotals, page: StatementStats): void {
  totals.documents_examined += page.documents_examined;
  totals.statements_stored += page.stored;
  totals.statements_unplaced += page.no_depot;
  totals.statement_positions_proposed += page.positions_proposed;
}

async function runEnrichment(run: EnrichRun): Promise<void> {
  try {
    let before: number | null = null;
    // First the papers the rules do not recognise: the model says which
    // kind each is, so the readers below take them as candidates too.
    do {
      const page = await classifyPendingPapers(200, { before, budgetMs: ENRICH_REQUEST_BUDGET_MS });
      run.totals.papers_recognized += page.settlements + page.statements;
      before = page.next_before;
    } while (before !== null);
    do {
      const page = await enrichPage(run.account_ids, 200, before);
      for (const k of SETTLEMENT_TOTAL_KEYS) run.totals[k] += page[k];
      before = page.next_before;
    } while (before !== null);
    // Then the depot statements: what the depots held, as snapshots.
    before = null;
    do {
      const page = await enrichPendingStatements(run.account_ids, 200, {}, { before, budgetMs: ENRICH_REQUEST_BUDGET_MS });
      addStatementPage(run.totals, page);
      before = page.next_before;
    } while (before !== null);
    run.status = "done";
  } catch (err) {
    run.status = "failed";
    run.error = (err as Error).message ?? String(err);
  } finally {
    run.finished_at = new Date().toISOString();
  }
}

/** For tests: wait for the user's run to end. */
export async function awaitDocumentEnrichRun(userId: number): Promise<void> {
  await enrichRunPromises.get(userId);
}

/** For tests: forget every run. */
export function resetDocumentEnrichRuns(): void {
  enrichRuns.clear();
  enrichRunPromises.clear();
}

/**
 * Start reading the documents into the caller's writable depots. While a
 * run of the caller's is still going, that run is answered and no second
 * one starts.
 */
export const startDocumentEnrichRun = api(
  { expose: true, method: "POST", path: "/finance/portfolio/documents/enrich/start", auth: true },
  async ({ accounts }: { accounts?: string }): Promise<{ run: EnrichRun }> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const userId = Number(auth.userID);
    const current = enrichRuns.get(userId);
    if (current?.status === "running") return { run: current };
    const depots = await writableDepots(auth, parseAccountIds(accounts));
    if (depots.length === 0) {
      throw APIError.permissionDenied("write access to at least one depot is required");
    }
    const run: EnrichRun = {
      id: ++enrichRunSeq,
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      account_ids: depots.map((d) => d.id),
      totals: emptyTotals(),
      error: null,
    };
    enrichRuns.set(userId, run);
    enrichRunPromises.set(userId, runEnrichment(run));
    return { run };
  },
);

/** The caller's running or last run; null when there was none since the app started. */
export const documentEnrichRunStatus = api(
  { expose: true, method: "GET", path: "/finance/portfolio/documents/enrich/status", auth: true },
  async (): Promise<{ run: EnrichRun | null }> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    return { run: enrichRuns.get(Number(auth.userID)) ?? null };
  },
);

// ----------------------------------------------------------------------
// What needs a look (#1336, stage 4)
//
// Three kinds of loose ends, across the depots in scope:
//   - conflicts: a settlement whose net disagrees with the transaction it
//     describes (found by a dry run, so the list is always current and
//     disappears once resolved),
//   - unmatched: a settlement no depot in scope holds the security of,
//   - holding gaps: share changes between snapshots no transaction
//     explains.
// Documents are listed only when the caller owns them or is a finance
// admin — a depot being shared does not share its owner's mail.
// ----------------------------------------------------------------------

export interface ReviewConflict {
  document_id: number;
  document_title: string | null;
  account_id: number;
  account_label: string;
  depot_transaction_id: number;
  position_key: string;
  name: string | null;
  kind: string;
  executed_at: string;
  statement_net: string | null;
  transaction_net: string | null;
  /** Marked "ignore for depots" (listed only with `ignored=true`). */
  ignored: boolean;
}

export interface ReviewDocument {
  document_id: number;
  document_title: string | null;
  doc_date: string | null;
  /** What the statement identified itself by — why no depot matched. */
  isin: string | null;
  wkn: string | null;
  depot_number: string | null;
  /** Marked "ignore for depots" (listed only with `ignored=true`). */
  ignored: boolean;
}

export interface ReviewHoldingGap extends HoldingGap {
  account_label: string;
  name: string | null;
}

/** A security met in bookings or papers that the depot's master has not confirmed. */
export interface ReviewSecurity extends ListedSecurity {
  account_label: string;
  /** Ignored by the user (listed only with `ignored=true`). */
  ignored: boolean;
}

/** A depot statement no depot could be found for (stage 2). */
export interface ReviewStatement {
  document_id: number;
  document_title: string | null;
  doc_date: string | null;
  /** The day the statement states the holdings for. */
  as_of: string | null;
  depot_number: string | null;
  /** Positions with an identifier the statement lists. */
  positions: number;
  /** The identifiers listed (ISIN, else WKN), at most five. */
  identifiers: string[];
  /** Marked "ignore for depots" (listed only with `ignored=true`). */
  ignored: boolean;
}

interface ReviewParams {
  accounts?: string;
  /** Include closed depots when no `accounts` are given. */
  closed?: boolean;
  /** List documents marked "ignore for depots" too, each in the group it would fall into. */
  ignored?: boolean;
}

interface ReviewResponse {
  conflicts: ReviewConflict[];
  unmatched_documents: ReviewDocument[];
  /** Rules and model read different figures that do not add up: nothing was booked. */
  unverified_documents: ReviewDocument[];
  holding_gaps: ReviewHoldingGap[];
  unverifiable_changes: number;
  /** Ignored documents that fall into none of the groups (only with `ignored=true`). */
  ignored_other: ReviewDocument[];
  /** How many documents the caller may see are marked "ignore for depots". */
  ignored_count: number;
  /** How many securities the depots in scope ignore (taken out, or a proposal turned down). */
  ignored_securities_count: number;
  /** Dividends booked from a notice of accumulated income or a Vorabpauschale. */
  misbooked_accumulations: (MisbookedAccumulation & { account_label: string })[];
  /** Securities proposed by bookings or papers, for the user to take in or ignore. */
  new_securities: ReviewSecurity[];
  /** Depot statements and reportings that could not be placed in a depot. */
  unplaced_statements: ReviewStatement[];
}

export const getPortfolioReview = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/portfolio/review",
    auth: true,
  },
  async ({ accounts, closed, ignored }: ReviewParams): Promise<ReviewResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const depots = scopeDepots(await visibleDepots(auth, null), parseAccountIds(accounts), closed === true);
    const ids = depots.map((d) => d.id);
    const mayShow = (userId: number) => hasAdmin(auth) || userId === Number(auth.userID);

    // Ignored documents the caller may see: counted always, listed on request.
    const ignoredRows = (
      await db
        .select({ id: documents.id, title: documents.title, user_id: documents.user_id, doc_date: documents.doc_date })
        .from(financeDepotDocumentIgnore)
        .innerJoin(documents, eq(documents.id, financeDepotDocumentIgnore.document_id))
        .orderBy(desc(documents.id))
    ).filter((d) => mayShow(d.user_id));

    if (ids.length === 0) {
      return {
        conflicts: [],
        unmatched_documents: [],
        unverified_documents: [],
        holding_gaps: [],
        unverifiable_changes: 0,
        ignored_other: [],
        ignored_count: ignoredRows.length,
        ignored_securities_count: 0,
        misbooked_accumulations: [],
        new_securities: [],
        unplaced_statements: [],
      };
    }
    const labelById = new Map(depots.map((d) => [d.id, d.label]));
    const identity = await securityIdentity();

    const [dry, recon, misbooked, securities, statements] = await Promise.all([
      enrichPendingDocuments(ids, 200, { dryRun: true, includeIgnored: ignored === true }),
      reconcileHoldings(ids),
      findMisbookedAccumulations(ids),
      listSecurities(ids, ignored === true ? ["proposed", "ignored"] : ["proposed"]),
      enrichPendingStatements(ids, 200, { dryRun: true, includeIgnored: ignored === true }),
    ]);

    const [ignoredSecurities] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(financeDepotSecurity)
      .where(and(inArray(financeDepotSecurity.account_id, ids), eq(financeDepotSecurity.status, "ignored")));

    // Statements without a depot, when the caller may see them.
    const unplacedResults = statements.results.filter((r) => r.outcome === "no_depot");
    const statementDocs = unplacedResults.length
      ? await db
          .select({ id: documents.id, title: documents.title, user_id: documents.user_id, doc_date: documents.doc_date })
          .from(documents)
          .where(inArray(documents.id, unplacedResults.map((r) => r.document_id)))
      : [];
    const statementDocById = new Map(statementDocs.filter((d) => mayShow(d.user_id)).map((d) => [d.id, d]));
    const unplacedStatements: ReviewStatement[] = [];
    for (const r of unplacedResults) {
      const doc = statementDocById.get(r.document_id);
      if (!doc) continue;
      unplacedStatements.push({
        document_id: doc.id,
        document_title: doc.title,
        doc_date: doc.doc_date,
        as_of: r.as_of,
        depot_number: r.depot_number,
        positions: r.positions_found,
        identifiers: r.identifiers,
        ignored: r.ignored,
      });
    }

    const relevant = dry.results.filter(
      (r) => r.outcome === "conflict" || r.outcome === "no_holding" || r.outcome === "unverified",
    );
    const docIds = [...new Set(relevant.map((r) => r.document_id))];
    const docRows = docIds.length
      ? await db
          .select({ id: documents.id, title: documents.title, user_id: documents.user_id, doc_date: documents.doc_date })
          .from(documents)
          .where(inArray(documents.id, docIds))
      : [];
    const docById = new Map(docRows.filter((d) => mayShow(d.user_id)).map((d) => [d.id, d]));

    const conflictTxIds = relevant
      .filter((r) => r.outcome === "conflict" && r.depot_transaction_id !== null)
      .map((r) => r.depot_transaction_id!);
    const txRows = conflictTxIds.length
      ? await db
          .select({
            id: financeDepotTransaction.id,
            account_id: financeDepotTransaction.account_id,
            isin: financeDepotTransaction.isin,
            wkn: financeDepotTransaction.wkn,
            name: financeDepotTransaction.name,
            kind: financeDepotTransaction.kind,
            executed_at: financeDepotTransaction.executed_at,
          })
          .from(financeDepotTransaction)
          .where(inArray(financeDepotTransaction.id, conflictTxIds))
      : [];
    const txById = new Map(txRows.map((t) => [t.id, t]));

    const conflicts: ReviewConflict[] = [];
    const unmatched: ReviewDocument[] = [];
    const unverified: ReviewDocument[] = [];
    for (const r of relevant) {
      const doc = docById.get(r.document_id);
      if (!doc) continue;
      if (r.outcome === "no_holding" || r.outcome === "unverified") {
        (r.outcome === "no_holding" ? unmatched : unverified).push({
          document_id: doc.id,
          document_title: doc.title,
          doc_date: doc.doc_date,
          isin: r.isin,
          wkn: r.wkn,
          depot_number: r.depot_number,
          ignored: r.ignored,
        });
        continue;
      }
      const tx = r.depot_transaction_id === null ? undefined : txById.get(r.depot_transaction_id);
      if (!tx) continue;
      conflicts.push({
        document_id: doc.id,
        document_title: doc.title,
        account_id: tx.account_id,
        account_label: labelById.get(tx.account_id) ?? "",
        depot_transaction_id: tx.id,
        position_key: identity.key(tx),
        name: tx.name,
        kind: tx.kind,
        executed_at: dateOnly(tx.executed_at),
        statement_net: r.statement_net,
        transaction_net: r.transaction_net,
        ignored: r.ignored,
      });
    }

    const listed = new Set(relevant.map((r) => r.document_id));
    const ignoredOther: ReviewDocument[] =
      ignored === true
        ? ignoredRows
            .filter((d) => !listed.has(d.id))
            .map((d) => ({
              document_id: d.id,
              document_title: d.title,
              doc_date: d.doc_date,
              isin: null,
              wkn: null,
              depot_number: null,
              ignored: true,
            }))
        : [];

    // Names for the gap rows from the latest snapshot that carries one.
    const names = new Map<string, string | null>();
    if (recon.gaps.length > 0) {
      const rows = await db
        .select({
          isin: financeAccountHolding.isin,
          wkn: financeAccountHolding.wkn,
          name: financeAccountHolding.name,
        })
        .from(financeAccountHolding)
        .where(inArray(financeAccountHolding.account_id, ids))
        .orderBy(desc(financeAccountHolding.as_of));
      for (const row of rows) {
        const k = positionKey(row);
        if (k && !names.has(k) && row.name) names.set(k, row.name);
      }
    }

    return {
      conflicts,
      unmatched_documents: unmatched,
      unverified_documents: unverified,
      holding_gaps: recon.gaps.map((g) => ({
        ...g,
        account_label: labelById.get(g.account_id) ?? "",
        name: names.get(g.position_key) ?? null,
      })),
      unverifiable_changes: recon.unverifiable,
      ignored_other: ignoredOther,
      ignored_count: ignoredRows.length,
      ignored_securities_count: ignoredSecurities?.n ?? 0,
      misbooked_accumulations: misbooked.map((m) => ({ ...m, account_label: labelById.get(m.account_id) ?? "" })),
      new_securities: securities.map((sec) => ({
        ...sec,
        account_label: labelById.get(sec.account_id) ?? "",
        ignored: sec.status === "ignored",
      })),
      unplaced_statements: unplacedStatements,
    };
  },
);

// ----------------------------------------------------------------------
// The securities master (documentation/plans/wertpapier-stamm.md, stage 1)
// ----------------------------------------------------------------------

interface SecurityDecisionParams {
  securityId: number;
  /** "confirm": book it from now on and read its evidence · "ignore": stay silent · "propose": undo a decision. */
  decision: "confirm" | "ignore" | "propose";
}

interface SecurityDecisionResponse {
  security_id: number;
  status: SecurityStatus;
  /** Transactions derived from bookings once the security was confirmed. */
  rederived: number;
  /** Papers of the evidence that booked something once the security was confirmed. */
  documents_read: number;
}

/**
 * The user's word on a proposed security. Taking one in reads its
 * evidence at once — the bookings of the depot's bankcontact and the
 * papers it was met in — so its rows appear without a full run.
 */
export const decideDepotSecurity = api(
  { expose: true, method: "POST", path: "/finance/portfolio/securities/:securityId/decision", auth: true },
  async ({ securityId, decision }: SecurityDecisionParams): Promise<SecurityDecisionResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const [sec] = await db.select().from(financeDepotSecurity).where(eq(financeDepotSecurity.id, securityId)).limit(1);
    if (!sec) throw APIError.notFound("security not found");
    if ((await writableDepots(auth, [sec.account_id])).length === 0) {
      throw APIError.permissionDenied("write access to the depot is required");
    }
    const row = await decideSecurity(securityId, decision, Number(auth.userID));
    let rederived = 0;
    let documentsRead = 0;
    if (decision === "confirm") {
      const [acc] = await db
        .select({ bankcontact_id: financeAccount.bankcontact_id })
        .from(financeAccount)
        .where(eq(financeAccount.id, sec.account_id))
        .limit(1);
      if (acc?.bankcontact_id != null) {
        rederived = (await deriveDepotTransactionsForBankcontact(acc.bankcontact_id)).derived;
      }
      for (const docId of await evidenceDocumentIds(securityId)) {
        const r = await enrichDocument(docId, [sec.account_id]);
        if (r.outcome === "created" || r.outcome === "enriched" || r.outcome === "linked") documentsRead++;
        // A statement that proposed it now stores its position.
        const s = await readDepotStatement(docId, [sec.account_id]);
        if (s.outcome === "stored") documentsRead++;
      }
    }
    return { security_id: securityId, status: row!.status as SecurityStatus, rederived, documents_read: documentsRead };
  },
);

interface CorrectAccumulationParams {
  depotTransactionId: number;
}

interface CorrectAccumulationResponse {
  depot_transaction_id: number;
  /** rebooked_as_tax: now a tax row · removed / unlinked: no tax was charged · not_found: nothing to correct. */
  result: "rebooked_as_tax" | "removed" | "unlinked" | "not_found";
}

/**
 * Correct a dividend booked from a notice of accumulated income or a
 * Vorabpauschale (see findMisbookedAccumulations). Write access to its
 * depot is required.
 */
export const correctAccumulationTransaction = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/portfolio/transactions/:depotTransactionId/correct-accumulation",
    auth: true,
  },
  async ({ depotTransactionId }: CorrectAccumulationParams): Promise<CorrectAccumulationResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const [row] = await db
      .select({ account_id: financeDepotTransaction.account_id })
      .from(financeDepotTransaction)
      .where(eq(financeDepotTransaction.id, depotTransactionId))
      .limit(1);
    if (!row) throw APIError.notFound(`depot transaction ${depotTransactionId} not found`);
    const depots = await writableDepots(auth, [row.account_id]);
    if (depots.length === 0) {
      throw APIError.permissionDenied("write access to the depot is required");
    }
    const result = await correctMisbookedAccumulation(depotTransactionId);
    return { depot_transaction_id: depotTransactionId, result };
  },
);

interface IgnoreDocumentParams {
  documentId: number;
}

interface IgnoreDocumentResponse {
  document_id: number;
  ignored: boolean;
}

/** The caller may change a document's depot relevance: their own (or any, as admin), with a writable depot. */
async function assertMayMarkDocument(documentId: number): Promise<number> {
  const auth = getAuthData()!;
  requirePermission(auth, "finance.view");
  const depots = await writableDepots(auth, null);
  if (depots.length === 0) {
    throw APIError.permissionDenied("write access to at least one depot is required");
  }
  const [doc] = await db
    .select({ user_id: documents.user_id })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!doc || (!hasAdmin(auth) && doc.user_id !== Number(auth.userID))) {
    throw APIError.notFound(`document ${documentId} not found`);
  }
  return Number(auth.userID);
}

/** Mark a document "ignore for depots": never read in, never listed for review. */
export const ignoreSettlementDocument = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/portfolio/documents/:documentId/ignore",
    auth: true,
  },
  async ({ documentId }: IgnoreDocumentParams): Promise<IgnoreDocumentResponse> => {
    const userId = await assertMayMarkDocument(documentId);
    await setIgnoredForDepots(documentId, true, userId);
    return { document_id: documentId, ignored: true };
  },
);

/** Take a document back: read in and reviewed like any other again. */
export const unignoreSettlementDocument = api(
  {
    expose: true,
    method: "DELETE",
    path: "/finance/portfolio/documents/:documentId/ignore",
    auth: true,
  },
  async ({ documentId }: IgnoreDocumentParams): Promise<IgnoreDocumentResponse> => {
    const userId = await assertMayMarkDocument(documentId);
    await setIgnoredForDepots(documentId, false, userId);
    return { document_id: documentId, ignored: false };
  },
);

interface ApplyDocumentParams {
  documentId: number;
}

export const applySettlementDocument = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/portfolio/documents/:documentId/apply",
    auth: true,
  },
  async ({ documentId }: ApplyDocumentParams): Promise<EnrichResult> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const depots = await writableDepots(auth, null);
    if (depots.length === 0) {
      throw APIError.permissionDenied("write access to at least one depot is required");
    }
    const [doc] = await db
      .select({ user_id: documents.user_id })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!doc || (!hasAdmin(auth) && doc.user_id !== Number(auth.userID))) {
      throw APIError.notFound(`document ${documentId} not found`);
    }
    const r = await enrichDocument(documentId, depots.map((d) => d.id), { overwrite: true });
    if (r.outcome === "not_settlement" || r.outcome === "no_holding" || r.outcome === "no_transaction") {
      throw APIError.failedPrecondition(`document ${documentId} cannot be applied (${r.outcome})`);
    }
    return r;
  },
);

// ----------------------------------------------------------------------
// What the parser read from one document (#1336)
//
// For the "what was recognised" view: every field the settlement parser
// looks for with the value it found (or null) and the label it read it
// after, why the text does or does not count as a settlement, which depot
// a dry run would pick and how, and the transactions the document is
// already linked to. Reading is rule-based only: there is no LLM
// fallback, and the response says so rather than leaving it to guess.
// ----------------------------------------------------------------------

type InspectionRejection =
  | "no_text"
  /** The rules recognised insurance paperwork (policy, surplus statement). */
  | "insurance"
  /** A cost disclosure (MiFID "Kosteninformation"): the settlement comes separately. */
  | "cost_info"
  /** An account statement with no settlement of its own (fees, interest, transfers). */
  | "account_statement"
  /** The model says it is something else and the rules found no word only a settlement prints. */
  | "llm_other"
  | "no_kind"
  | "no_identifier"
  | "no_date"
  | "no_amount";

interface InspectionFields {
  kind: string | null;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  depot_number: string | null;
  executed_at: string | null;
  quantity: string | null;
  price: string | null;
  gross: string | null;
  fees: string | null;
  tax: string | null;
  net: string | null;
  currency: string | null;
}

type InspectionFieldKey = keyof InspectionFields;

interface InspectionFieldSource {
  /** What the rules read (formatted like `fields`), or null. */
  rules: string | null;
  /** What the model read, or null (also when it was not asked). */
  llm: string | null;
  /** Where the value in `fields` came from; "both" when they agree. */
  source: FieldSource;
  disagree: boolean;
  /** The taxes' sign was turned because only that way the figures add up. */
  sign_turned?: boolean;
  /** Snapped to a known security: what was read. */
  known_from?: string;
}

interface InspectionCheck {
  name: CheckName;
  result: "ok" | "failed" | "skipped";
  detail: string | null;
}

interface InspectionLink {
  depot_transaction_id: number;
  account_id: number;
  account_label: string;
  position_key: string;
  kind: string;
  executed_at: string;
  net_amount: string | null;
}

interface DocumentInspectionResponse {
  document_id: number;
  title: string | null;
  doc_date: string | null;
  /** "rules" without a model answer, "rules+llm" with one. */
  method: "rules" | "rules+llm";
  /** True when the model's answer took part in this reading. */
  llm_fallback_used: boolean;
  /** What happened with the model: used now, cached, unavailable, skipped. */
  llm_status: LlmStatus;
  /** True when the reading counts as a settlement with enough to book. */
  is_settlement: boolean;
  /** A tax statement on its own: it only adds the tax to an existing transaction. */
  tax_statement: boolean;
  /** A credit note whose amount is before taxes: a separate tax statement completes it. */
  tax_pending: boolean;
  /** Accumulated income or a Vorabpauschale: only the tax charged is booked. */
  accumulation: boolean;
  /** Which kind of paper: its fields, checks and matching follow from it. */
  paper_type: PaperType | null;
  /** Why it does not, when it does not. */
  rejection: InspectionRejection | null;
  /** The reading that is used — rules and model merged. */
  fields: InspectionFields;
  /** Per field: what each source read and which one was used. */
  sources: Record<InspectionFieldKey, InspectionFieldSource>;
  /** The arithmetic and format checks the used reading was put through. */
  checks: InspectionCheck[];
  /** "unverified": rules and model disagree and the figures do not settle it. */
  verdict: "ok" | "unverified";
  /** The printed label the rules read each field after ("Kurswert", "Schlusstag", …). */
  labels: Record<string, string>;
  /** What enrichment would do now (dry run), with the depot's label. */
  depot: (EnrichResult & { account_label: string | null }) | null;
  links: InspectionLink[];
}

interface InspectDocumentParams {
  documentId: number;
}

function numOut(n: number | null, scale: number): string | null {
  return n === null ? null : n.toFixed(scale);
}

export const inspectSettlementDocument = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/portfolio/documents/:documentId/inspection",
    auth: true,
  },
  async ({ documentId }: InspectDocumentParams): Promise<DocumentInspectionResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const [doc] = await db
      .select({
        id: documents.id,
        user_id: documents.user_id,
        title: documents.title,
        doc_date: documents.doc_date,
        extracted_text: documents.extracted_text,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!doc || (!hasAdmin(auth) && doc.user_id !== Number(auth.userID))) {
      throw APIError.notFound(`document ${documentId} not found`);
    }

    const depots = await visibleDepots(auth, null);
    const labelById = new Map(depots.map((d) => [d.id, d.label]));
    const identity = await securityIdentity();
    const ids = depots.map((d) => d.id);

    // The user is looking at this one document: ask the model if it has
    // not been asked yet, so the view shows both readings.
    const reading = await readSettlement(documentId, doc.extracted_text, "allow");
    const v = reading.merge.values;
    let rejection: InspectionRejection | null = null;
    const otherPaper = rejectedAsOtherPaper(reading);
    if (!doc.extracted_text || doc.extracted_text.trim().length === 0) rejection = "no_text";
    else if (otherPaper) rejection = otherPaper;
    else if (!v.kind) rejection = "no_kind";
    else if (!v.isin && !v.wkn) rejection = "no_identifier";
    else if (!v.executedAt && !doc.doc_date) rejection = "no_date";
    else if (v.net === null && v.gross === null && (v.quantity === null || v.price === null)) rejection = "no_amount";

    const dry = rejection === null && ids.length > 0
      ? await enrichDocument(documentId, ids, { dryRun: true, llm: "cache-only" })
      : null;

    const linkRows = await db
      .select({
        id: financeDepotTransaction.id,
        account_id: financeDepotTransaction.account_id,
        isin: financeDepotTransaction.isin,
        wkn: financeDepotTransaction.wkn,
        name: financeDepotTransaction.name,
        kind: financeDepotTransaction.kind,
        executed_at: financeDepotTransaction.executed_at,
        net_amount: financeDepotTransaction.net_amount,
        linked_transaction_id: financeDepotTransaction.linked_transaction_id,
        source: financeDepotTransaction.source,
      })
      .from(financeDepotTransactionDocument)
      .innerJoin(
        financeDepotTransaction,
        eq(financeDepotTransaction.id, financeDepotTransactionDocument.depot_transaction_id),
      )
      .where(eq(financeDepotTransactionDocument.document_id, documentId));

    // The booking decides between rules and model: the one a dry run
    // matched, or the one the document is already linked to — if an account
    // booking confirmed it. A row this document created only repeats what
    // was read off it and proves nothing.
    const bookingNet =
      dry?.checked_against_booking && dry.transaction_net !== null
        ? dry.transaction_net
        : reading.llm &&
            linkRows.length === 1 &&
            (linkRows[0]!.source !== "document" || linkRows[0]!.linked_transaction_id !== null)
          ? linkRows[0]!.net_amount
          : null;
    const shown = bookingNet !== null ? rereadAgainstBooking(reading, Number(bookingNet)) : reading;
    const sv = shown.merge.values;

    const show = (field: MergeField, raw: string | number | null): string | null => {
      if (raw === null) return null;
      switch (field) {
        case "quantity": return numOut(Number(raw), 8);
        case "price": return numOut(Number(raw), 6);
        case "gross":
        case "fees":
        case "tax":
        case "net": return numOut(Number(raw), 2);
        default: return String(raw);
      }
    };
    const keyOf = (field: MergeField): InspectionFieldKey =>
      field === "depotNumber" ? "depot_number" : field === "executedAt" ? "executed_at" : field;
    const fields = {} as InspectionFields;
    const sources = {} as Record<InspectionFieldKey, InspectionFieldSource>;
    for (const f of shown.merge.fields) {
      const key = keyOf(f.field);
      fields[key] = show(f.field, sv[f.field]);
      sources[key] = {
        rules: show(f.field, f.rules),
        llm: show(f.field, f.llm),
        source: f.source,
        disagree: f.disagree,
        ...(f.sign_turned ? { sign_turned: true } : {}),
        ...(f.known_from ? { known_from: f.known_from } : {}),
      };
    }

    return {
      document_id: doc.id,
      title: doc.title,
      doc_date: doc.doc_date,
      method: reading.llm ? "rules+llm" : "rules",
      llm_fallback_used: reading.llm !== null,
      llm_status: reading.llmStatus,
      is_settlement: rejection === null,
      tax_statement: reading.rules?.taxStatement ?? false,
      tax_pending: reading.rules?.taxPending ?? false,
      accumulation: reading.rules?.accumulation ?? false,
      paper_type: paperTypeOf(reading.rules),
      rejection,
      fields,
      sources,
      checks: shown.merge.checks,
      verdict: shown.merge.verdict,
      labels: Object.fromEntries(
        Object.entries(reading.rules?.labels ?? {}).map(([k, val]) => [
          k === "depotNumber" ? "depot_number" : k === "executedAt" ? "executed_at" : k,
          val as string,
        ]),
      ),
      depot: dry
        ? { ...dry, account_label: dry.account_id === null ? null : labelById.get(dry.account_id) ?? null }
        : null,
      links: linkRows
        .filter((r) => labelById.has(r.account_id))
        .map((r) => ({
          depot_transaction_id: r.id,
          account_id: r.account_id,
          account_label: labelById.get(r.account_id) ?? "",
          position_key: identity.key(r),
          kind: r.kind,
          executed_at: dateOnly(r.executed_at),
          net_amount: r.net_amount,
        })),
    };
  },
);

// ----------------------------------------------------------------------
// Read the documents in afresh (#1336)
//
// The readings improved over time; what earlier versions booked stays
// until someone undoes it. This takes back everything documents put into
// the given depots and lets the next "Belege einlesen" start over:
//
//   - transactions a document created, and those derived from an account
//     booking (completed by a document or not), are deleted — the derived
//     ones come back from their booking right away (derivation below),
//     read with today's rules: a booking an earlier rule took for a trade
//     and today's does not stays gone, instead of surviving every reset
//     behind its dedupe hash;
//   - a manual transaction a document completed stays, only its link to
//     the document goes (which values the document added is not recorded);
//   - the model's stored answers for the caller's documents (all of them
//     for an admin) are cleared, so it reads them again with today's hints;
//   - "ignore for depots" marks stay.
// ----------------------------------------------------------------------

interface ResetDocumentsParams {
  accounts?: string;
}

interface ResetDocumentsResponse {
  /** Transactions deleted (created from documents, or derived from bookings). */
  removed: number;
  /** Manual transactions that only lost their link to a document. */
  unlinked: number;
  /** Stored model answers cleared (settlements, statements and paper types). */
  answers_cleared: number;
  /** Holdings rows read from depot statements deleted; the statements are read again on the next run. */
  holdings_removed: number;
  /** Transactions derived again from account bookings. */
  rederived: number;
}

export const resetDocumentReadings = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/portfolio/documents/reset",
    auth: true,
  },
  async ({ accounts }: ResetDocumentsParams): Promise<ResetDocumentsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const depots = await writableDepots(auth, parseAccountIds(accounts));
    if (depots.length === 0) {
      throw APIError.permissionDenied("write access to at least one depot is required");
    }
    const ids = depots.map((d) => d.id);

    const removed = await db
      .delete(financeDepotTransaction)
      .where(
        and(
          inArray(financeDepotTransaction.account_id, ids),
          inArray(financeDepotTransaction.source, ["document", "giro-derived", "giro-derived+document"]),
        ),
      )
      .returning({ id: financeDepotTransaction.id });

    const kept = await db
      .select({ id: financeDepotTransaction.id })
      .from(financeDepotTransaction)
      .where(
        and(
          inArray(financeDepotTransaction.account_id, ids),
          sql`${financeDepotTransaction.source} LIKE '%+document'`,
        ),
      );
    if (kept.length > 0) {
      await db
        .delete(financeDepotTransactionDocument)
        .where(inArray(financeDepotTransactionDocument.depot_transaction_id, kept.map((k) => k.id)));
      await db
        .update(financeDepotTransaction)
        .set({ source: sql`replace(${financeDepotTransaction.source}, '+document', '')` })
        .where(inArray(financeDepotTransaction.id, kept.map((k) => k.id)));
    }
    // Links of the remaining rows (a document linked to a booking without
    // changing it) go too, so every document is read again.
    await db
      .delete(financeDepotTransactionDocument)
      .where(
        inArray(
          financeDepotTransactionDocument.depot_transaction_id,
          db
            .select({ id: financeDepotTransaction.id })
            .from(financeDepotTransaction)
            .where(inArray(financeDepotTransaction.account_id, ids)),
        ),
      );

    const ownDocuments = db.select({ id: documents.id }).from(documents).where(eq(documents.user_id, Number(auth.userID)));
    const cleared = await db
      .delete(financeDocumentSettlementLlm)
      .where(hasAdmin(auth) ? sql`true` : inArray(financeDocumentSettlementLlm.document_id, ownDocuments))
      .returning({ id: financeDocumentSettlementLlm.document_id });
    const clearedStatements = await db
      .delete(financeDocumentStatementLlm)
      .where(hasAdmin(auth) ? sql`true` : inArray(financeDocumentStatementLlm.document_id, ownDocuments))
      .returning({ id: financeDocumentStatementLlm.document_id });
    const clearedPaperTypes = await db
      .delete(financeDocumentPaperLlm)
      .where(hasAdmin(auth) ? sql`true` : inArray(financeDocumentPaperLlm.document_id, ownDocuments))
      .returning({ id: financeDocumentPaperLlm.document_id });

    // What statements wrote into the holdings goes too: they are read again with today's rules.
    const holdingsRemoved = await db
      .delete(financeAccountHolding)
      .where(and(inArray(financeAccountHolding.account_id, ids), eq(financeAccountHolding.source, "document")))
      .returning({ id: financeAccountHolding.id });

    const bankcontacts = await db
      .selectDistinct({ id: financeAccount.bankcontact_id })
      .from(financeAccount)
      .where(inArray(financeAccount.id, ids));
    let rederived = 0;
    for (const bc of bankcontacts) {
      if (bc.id === null) continue;
      rederived += (await deriveDepotTransactionsForBankcontact(bc.id)).derived;
    }

    return {
      removed: removed.length,
      unlinked: kept.length,
      answers_cleared: cleared.length + clearedStatements.length + clearedPaperTypes.length,
      holdings_removed: holdingsRemoved.length,
      rederived,
    };
  },
);
