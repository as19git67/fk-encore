import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { eq, and, desc, sql, lt } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { financeSavedAnalysis, type SavedAnalysisSummary } from "../db/schema";
import type { AnalysisAst } from "./llm-client";

console.log("[boot] finance/saved-analysis.ts: all imports resolved");

// -----------------------------------------------------------------------
// DTO shapes
// -----------------------------------------------------------------------

interface SavedAnalysisItem {
  id: number;
  name: string;
  question: string | null;
  ast: AnalysisAst;
  source: "user" | "ai";
  summary: SavedAnalysisSummary | null;
  seenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListRequest {
  limit?: number;
  /** ISO timestamp — return items created before this cursor. */
  before?: string;
  source?: "user" | "ai" | "all";
}

interface ListResponse {
  items: SavedAnalysisItem[];
  hasMore: boolean;
}

interface SaveRequest {
  name: string;
  question?: string;
  ast: AnalysisAst;
  summary?: SavedAnalysisSummary;
}

interface UpdateRequest {
  id: number;
  name?: string;
  ast?: AnalysisAst;
  summary?: SavedAnalysisSummary;
}

interface IdRequest {
  id: number;
}

interface MarkSeenRequest {
  ids: number[];
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function toItem(row: typeof financeSavedAnalysis.$inferSelect): SavedAnalysisItem {
  return {
    id: row.id,
    name: row.name,
    question: row.question,
    ast: row.ast as unknown as AnalysisAst,
    source: row.source,
    summary: row.summary ?? null,
    seenAt: row.seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// -----------------------------------------------------------------------
// GET /finance/saved-analysis — list
// -----------------------------------------------------------------------

export const list = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/saved-analysis/list",
    auth: true,
  },
  async (req: ListRequest): Promise<ListResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const userId = Number(auth.userID);

    const pageSize = Math.min(Math.max(req.limit ?? 20, 1), 100);
    const sourceFilter = req.source === "user" || req.source === "ai" ? req.source : undefined;

    const conditions = [eq(financeSavedAnalysis.user_id, userId)];
    if (sourceFilter) {
      conditions.push(eq(financeSavedAnalysis.source, sourceFilter));
    }
    if (req.before) {
      conditions.push(lt(financeSavedAnalysis.created_at, req.before));
    }

    const rows = await db
      .select()
      .from(financeSavedAnalysis)
      .where(and(...conditions))
      .orderBy(desc(financeSavedAnalysis.created_at))
      .limit(pageSize + 1);

    const hasMore = rows.length > pageSize;
    const items = rows.slice(0, pageSize).map(toItem);

    return { items, hasMore };
  },
);

// -----------------------------------------------------------------------
// POST /finance/saved-analysis — save
// -----------------------------------------------------------------------

export const save = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/saved-analysis",
    auth: true,
  },
  async (req: SaveRequest): Promise<SavedAnalysisItem> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    if (!req.name || req.name.trim().length === 0) {
      throw APIError.invalidArgument("name must be a non-empty string");
    }
    if (!req.ast || typeof req.ast !== "object") {
      throw APIError.invalidArgument("ast must be an object");
    }

    const [row] = await db
      .insert(financeSavedAnalysis)
      .values({
        user_id: Number(auth.userID),
        name: req.name.trim(),
        question: req.question?.trim() || null,
        ast: req.ast as Record<string, unknown>,
        source: "user",
        summary: req.summary ?? null,
      })
      .returning();

    return toItem(row);
  },
);

// -----------------------------------------------------------------------
// PUT /finance/saved-analysis/:id — update
// -----------------------------------------------------------------------

export const update = api(
  {
    expose: true,
    method: "PUT",
    path: "/finance/saved-analysis/:id",
    auth: true,
  },
  async (req: UpdateRequest): Promise<SavedAnalysisItem> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const userId = Number(auth.userID);

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (req.name !== undefined) {
      if (req.name.trim().length === 0) {
        throw APIError.invalidArgument("name must be non-empty");
      }
      updates.name = req.name.trim();
    }
    if (req.ast !== undefined) {
      updates.ast = req.ast;
    }
    if (req.summary !== undefined) {
      updates.summary = req.summary;
    }

    const rows = await db
      .update(financeSavedAnalysis)
      .set(updates)
      .where(
        and(
          eq(financeSavedAnalysis.id, req.id),
          eq(financeSavedAnalysis.user_id, userId),
        ),
      )
      .returning();

    if (rows.length === 0) {
      throw APIError.notFound("saved analysis not found");
    }
    return toItem(rows[0]);
  },
);

// -----------------------------------------------------------------------
// DELETE /finance/saved-analysis/:id
// -----------------------------------------------------------------------

export const remove = api(
  {
    expose: true,
    method: "DELETE",
    path: "/finance/saved-analysis/:id",
    auth: true,
  },
  async (req: IdRequest): Promise<void> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const userId = Number(auth.userID);

    const deleted = await db
      .delete(financeSavedAnalysis)
      .where(
        and(
          eq(financeSavedAnalysis.id, req.id),
          eq(financeSavedAnalysis.user_id, userId),
        ),
      )
      .returning({ id: financeSavedAnalysis.id });

    if (deleted.length === 0) {
      throw APIError.notFound("saved analysis not found");
    }
  },
);

// -----------------------------------------------------------------------
// POST /finance/saved-analysis/mark-seen — mark AI insights as seen
// -----------------------------------------------------------------------

export const markSeen = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/saved-analysis/mark-seen",
    auth: true,
  },
  async (req: MarkSeenRequest): Promise<void> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const userId = Number(auth.userID);

    if (!Array.isArray(req.ids) || req.ids.length === 0) return;

    const idList = sql.join(
      req.ids.map((id) => sql`${id}`),
      sql`, `,
    );

    await db.execute(sql`
      UPDATE finance_saved_analysis
      SET seen_at = NOW()
      WHERE id IN (${idList})
        AND user_id = ${userId}
        AND seen_at IS NULL
    `);
  },
);
