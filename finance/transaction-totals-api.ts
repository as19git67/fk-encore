/**
 * `POST /finance/transactions/totals`: sums with subtotals for the bookings a
 * filter or a Sammelmappe describes (the numbers come from transaction-totals.ts).
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import db from "../db/database";
import { financeTag, financeTagTransaction, financeTransaction } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { collectionScopeCondition, parseCollectionId } from "../collections/scope";
import { readableFinanceAccountIds } from "./account-acl";
import { criteriaConditions, type TransactionCriteria } from "./transaction-conditions";
import {
  cleanCriteria,
  computeTotals,
  normalizeTotalsSpec,
  type TotalsGroupBy,
  type TransactionTotals,
} from "./transaction-totals";

/** The user's tags of these bookings, by booking. */
async function userTagsOf(ids: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  for (let i = 0; i < ids.length; i += 5000) {
    const rows = await db
      .select({ id: financeTagTransaction.transaction_id, name: financeTag.name })
      .from(financeTagTransaction)
      .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
      .where(and(inArray(financeTagTransaction.transaction_id, ids.slice(i, i + 5000)), eq(financeTag.source, "user")));
    for (const r of rows) {
      const list = out.get(r.id) ?? [];
      list.push(r.name);
      out.set(r.id, list);
    }
  }
  return out;
}

export interface TransactionTotalsRequest {
  /** The list's filter and search … */
  criteria?: TransactionCriteria;
  /** … or the bookings of this Sammelmappe. */
  collection_id?: number;
  group_by?: TotalsGroupBy;
  /** By tag: only these tags get a group of their own. */
  group_tags?: string[];
}

/**
 * Totals of the bookings the caller may read that match `criteria` (and, if
 * given, belong to `collection_id`). Without either it refuses: "everything"
 * is a question for the overview page.
 */
export const transactionTotals = api(
  { expose: true, method: "POST", path: "/finance/transactions/totals", auth: true },
  async (req: TransactionTotalsRequest): Promise<TransactionTotals> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("Unauthorized");
    requirePermission(auth, "finance.view");

    const criteria = cleanCriteria(req.criteria);
    const collectionId = parseCollectionId(req.collection_id);
    if (!collectionId && Object.keys(criteria).length === 0) {
      throw APIError.invalidArgument("say which bookings: criteria or collection_id");
    }
    const spec = normalizeTotalsSpec({ group_by: req.group_by, tags: req.group_tags }) ?? { group_by: "none" as const };

    const readable = await readableFinanceAccountIds(auth);
    const conds: SQL[] = [...criteriaConditions(criteria)];
    if (readable !== null) {
      if (readable.length === 0) return computeTotals([], spec);
      conds.push(inArray(financeTransaction.account_id, readable));
    }
    if (collectionId) {
      conds.push(collectionScopeCondition("transaction", financeTransaction.id, collectionId, Number(auth.userID)));
    }
    const rows = await db
      .select({
        id: financeTransaction.id,
        booking_date: financeTransaction.booking_date,
        amount: financeTransaction.amount,
        currency_code: financeTransaction.currency_code,
      })
      .from(financeTransaction)
      .where(and(...conds));
    const tags = spec.group_by === "tag" ? await userTagsOf(rows.map((r) => r.id)) : new Map<number, string[]>();
    return computeTotals(
      rows.map((r) => ({ ...r, booking_date: String(r.booking_date), amount: String(r.amount), tags: tags.get(r.id) ?? [] })),
      spec,
    );
  },
);
