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
