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
import { asc, eq, sql } from "drizzle-orm";

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

    const source = p.source ?? "user";

    if (source === "all") {
      // Deduplicate by name, preferring 'user' over 'ai' so that
      // promoted tags don't appear twice in look-ahead lists (#326).
      const rows = await db.execute<{
        id: number;
        name: string;
        source: "user" | "ai";
        created_at: string;
      }>(sql`
        SELECT DISTINCT ON (name) id, name, source, created_at
        FROM finance_tag
        ORDER BY name, CASE WHEN source = 'user' THEN 0 ELSE 1 END
      `);
      return {
        items: rows.rows.map((r) => ({
          id: r.id,
          name: r.name,
          source: r.source,
          created_at: r.created_at,
        })),
      };
    }

    if (
      !(financeTagSourceEnum.enumValues as readonly string[]).includes(source)
    ) {
      return { items: [] };
    }

    const rows = await db
      .select()
      .from(financeTag)
      .where(eq(financeTag.source, source))
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
