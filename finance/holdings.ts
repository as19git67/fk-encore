import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, desc, eq, sql } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountHolding,
} from "../db/schema";

console.log("[boot] finance/holdings.ts: all imports resolved");

interface HoldingView {
  id: number;
  account_id: number;
  as_of: string;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  amount: string | null;
  price: string | null;
  value: string | null;
  currency: string | null;
  acquisition_date: string | null;
  acquisition_price: string | null;
}

interface ListHoldingsParams {
  id: number;
  asOf?: string;
}

interface ListHoldingsResponse {
  items: HoldingView[];
  as_of: string | null;
}

function hasAdmin(auth: { permissions: string[] }): boolean {
  return auth.permissions.includes("finance.admin");
}

async function assertAclRead(accountId: number, userId: number): Promise<void> {
  const [row] = await db
    .select({ user_id: financeAccountAccess.user_id })
    .from(financeAccountAccess)
    .where(
      and(
        eq(financeAccountAccess.account_id, accountId),
        eq(financeAccountAccess.user_id, userId),
      ),
    )
    .limit(1);
  if (!row) {
    throw APIError.notFound(`account ${accountId} not found`);
  }
}

export const listHoldings = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/accounts/:id/holdings",
    auth: true,
  },
  async ({ id, asOf }: ListHoldingsParams): Promise<ListHoldingsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const [account] = await db
      .select({ id: financeAccount.id })
      .from(financeAccount)
      .where(eq(financeAccount.id, id))
      .limit(1);
    if (!account) throw APIError.notFound(`account ${id} not found`);

    if (!hasAdmin(auth)) {
      await assertAclRead(id, Number(auth.userID));
    }

    let resolvedAsOf: string | null = null;

    if (asOf) {
      resolvedAsOf = asOf;
    } else {
      const [latest] = await db
        .select({ as_of: financeAccountHolding.as_of })
        .from(financeAccountHolding)
        .where(eq(financeAccountHolding.account_id, id))
        .orderBy(desc(financeAccountHolding.as_of))
        .limit(1);
      resolvedAsOf = latest?.as_of ?? null;
    }

    if (!resolvedAsOf) {
      return { items: [], as_of: null };
    }

    const rows = await db
      .select()
      .from(financeAccountHolding)
      .where(
        and(
          eq(financeAccountHolding.account_id, id),
          eq(financeAccountHolding.as_of, resolvedAsOf),
        ),
      )
      .orderBy(desc(sql`CAST(${financeAccountHolding.value} AS NUMERIC)`));

    return {
      items: rows.map((r) => ({
        id: r.id,
        account_id: r.account_id,
        as_of: typeof r.as_of === "string" ? r.as_of.slice(0, 10) : r.as_of,
        isin: r.isin,
        wkn: r.wkn,
        name: r.name,
        amount: r.amount,
        price: r.price,
        value: r.value,
        currency: r.currency,
        acquisition_date: r.acquisition_date
          ? (typeof r.acquisition_date === "string"
              ? r.acquisition_date.slice(0, 10)
              : r.acquisition_date)
          : null,
        acquisition_price: r.acquisition_price,
      })),
      as_of: resolvedAsOf.slice(0, 10),
    };
  },
);

// ----------------------------------------------------------------------
// Holdings history (Phase 1 of #428 / #439)
//
// Aggregates the per-day holding snapshots into:
//   - a depot-wide total-value series (SUM(value) GROUP BY as_of), and
//   - a per-position series (key = COALESCE(isin, wkn, name), same
//     identity used by the upsert in statement-persist.ts).
//
// Range filtering: optional from/to as YYYY-MM-DD inclusive bounds.
// ----------------------------------------------------------------------

interface HistoryPoint {
  as_of: string;
  amount: string | null;
  price: string | null;
  value: string | null;
}

interface PositionSeries {
  key: string;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  currency: string | null;
  points: HistoryPoint[];
}

interface TotalPoint {
  as_of: string;
  total_value: string;
  currency: string | null;
}

interface HoldingsHistoryParams {
  id: number;
  from?: string;
  to?: string;
}

interface HoldingsHistoryResponse {
  totals: TotalPoint[];
  positions: PositionSeries[];
  from: string | null;
  to: string | null;
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
  return (
    (r.isin && r.isin.length > 0 && r.isin) ||
    (r.wkn && r.wkn.length > 0 && r.wkn) ||
    (r.name && r.name.length > 0 && r.name) ||
    ""
  );
}

export const getHoldingsHistory = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/accounts/:id/holdings/history",
    auth: true,
  },
  async ({
    id,
    from,
    to,
  }: HoldingsHistoryParams): Promise<HoldingsHistoryResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const fromDate = normalizeDate(from, "from");
    const toDate = normalizeDate(to, "to");
    if (fromDate && toDate && fromDate > toDate) {
      throw APIError.invalidArgument("from must be on or before to");
    }

    const [account] = await db
      .select({ id: financeAccount.id })
      .from(financeAccount)
      .where(eq(financeAccount.id, id))
      .limit(1);
    if (!account) throw APIError.notFound(`account ${id} not found`);

    if (!hasAdmin(auth)) {
      await assertAclRead(id, Number(auth.userID));
    }

    const conditions = [eq(financeAccountHolding.account_id, id)];
    if (fromDate) {
      conditions.push(sql`${financeAccountHolding.as_of} >= ${fromDate}::date`);
    }
    if (toDate) {
      conditions.push(sql`${financeAccountHolding.as_of} <= ${toDate}::date`);
    }

    const rows = await db
      .select({
        as_of: financeAccountHolding.as_of,
        isin: financeAccountHolding.isin,
        wkn: financeAccountHolding.wkn,
        name: financeAccountHolding.name,
        amount: financeAccountHolding.amount,
        price: financeAccountHolding.price,
        value: financeAccountHolding.value,
        currency: financeAccountHolding.currency,
      })
      .from(financeAccountHolding)
      .where(and(...conditions))
      .orderBy(financeAccountHolding.as_of);

    if (rows.length === 0) {
      return { totals: [], positions: [], from: fromDate, to: toDate };
    }

    // Totals per as_of — sum of all position values that day.
    const totalsByDate = new Map<string, { sum: number; currency: string | null }>();
    // Positions keyed by COALESCE(isin, wkn, name) so we track the same
    // identity that the upsert uses.
    const positionsByKey = new Map<string, PositionSeries>();

    for (const r of rows) {
      const asOf =
        typeof r.as_of === "string" ? r.as_of.slice(0, 10) : String(r.as_of);

      const v = r.value === null ? null : Number(r.value);
      if (v !== null && Number.isFinite(v)) {
        const entry = totalsByDate.get(asOf) ?? { sum: 0, currency: r.currency };
        entry.sum += v;
        if (!entry.currency) entry.currency = r.currency;
        totalsByDate.set(asOf, entry);
      } else if (!totalsByDate.has(asOf)) {
        totalsByDate.set(asOf, { sum: 0, currency: r.currency });
      }

      const key = positionKey(r);
      if (!key) continue;
      let series = positionsByKey.get(key);
      if (!series) {
        series = {
          key,
          isin: r.isin,
          wkn: r.wkn,
          name: r.name,
          currency: r.currency,
          points: [],
        };
        positionsByKey.set(key, series);
      } else {
        // Keep the most recent non-null name/isin/wkn — older snapshots
        // sometimes have less metadata.
        if (r.isin && !series.isin) series.isin = r.isin;
        if (r.wkn && !series.wkn) series.wkn = r.wkn;
        if (r.name) series.name = r.name;
        if (r.currency && !series.currency) series.currency = r.currency;
      }
      series.points.push({
        as_of: asOf,
        amount: r.amount,
        price: r.price,
        value: r.value,
      });
    }

    const totals: TotalPoint[] = Array.from(totalsByDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([as_of, { sum, currency }]) => ({
        as_of,
        total_value: sum.toFixed(2),
        currency,
      }));

    const positions = Array.from(positionsByKey.values()).sort((a, b) => {
      const an = (a.name ?? a.isin ?? a.wkn ?? "").toLowerCase();
      const bn = (b.name ?? b.isin ?? b.wkn ?? "").toLowerCase();
      return an.localeCompare(bn);
    });

    return { totals, positions, from: fromDate, to: toDate };
  },
);
