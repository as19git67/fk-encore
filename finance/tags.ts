/**
 * Tag listing for the finance module.
 *
 * Only user-confirmed tags are returned by default — AI suggestions
 * live with the transaction they were proposed on (see
 * TransactionDetailView §4.10) and aren't useful as a global picker
 * list.
 *
 * Permission: `finance.view` — same as reading transactions, since
 * the tag set is trivially derivable from what the user sees.
 */

import { api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, asc, eq, type SQLWrapper } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { financeTag, financeTagSourceEnum } from "../db/schema";

console.log("[boot] finance/tags.ts: all imports resolved");

interface TagView {
  id: number;
  name: string;
  source: "user" | "ai";
  created_at: string | null;
}

interface ListParams {
  /** Optional source filter. Defaults to 'user'. Pass 'all' for every tag. */
  source?: "user" | "ai" | "all";
}

interface ListResponse {
  items: TagView[];
}

export const listTags = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/tags",
    auth: true,
  },
  async (p: ListParams): Promise<ListResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const conds: SQLWrapper[] = [];
    const source = p.source ?? "user";
    if (source !== "all") {
      if (
        !(financeTagSourceEnum.enumValues as readonly string[]).includes(source)
      ) {
        // Hitting this means a client supplied an invalid literal; return
        // the empty set rather than crashing.
        return { items: [] };
      }
      conds.push(eq(financeTag.source, source));
    }

    const rows = await db
      .select()
      .from(financeTag)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(asc(financeTag.name));

    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        source: r.source,
        created_at: r.created_at,
      })),
    };
  },
);
