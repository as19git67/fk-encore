/**
 * Natural-language analysis over finance transactions (Etappe 9).
 *
 *   POST /finance/analysis/query     — freetext question → AST + aggregates
 *   POST /finance/analysis/aggregate — AST → aggregates only (for UI chip edits,
 *                                      no LLM cost)
 *
 * The AST drives three SQL aggregations (total, by-month, top
 * counterparties) built from the same filter fragment. Non-admin
 * callers get their results automatically scoped to accounts they
 * can read via finance_account_access.
 *
 * Architecture: docs/finance-tagging-and-ai.md §4.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { eq, sql, type SQLWrapper } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import { checkRateLimit } from "../user/rateLimiter";
import db from "../db/database";
import { financeAccountAccess, financeTag } from "../db/schema";
import {
  parseAnalysisQuery,
  LlmServiceUnavailableError,
  type AnalysisAst,
} from "./llm-client";

console.log("[boot] finance/analysis.ts: all imports resolved");

// -----------------------------------------------------------------------
// DTO shapes
// -----------------------------------------------------------------------

interface QueryRequest {
  question: string;
  timespanHint?: string;
  /** Optional — when provided, the aggregate is further restricted. */
  accountIds?: number[];
}

interface AggregateRequest {
  ast: AnalysisAst;
  accountIds?: number[];
}

export interface AnalysisResult {
  ast: AnalysisAst;
  total: { sum: string; count: number; avg: string };
  byMonth: Array<{ month: string; sum: string; count: number }>;
  topCounterparties: Array<{ name: string; sum: string; count: number }>;
}

// -----------------------------------------------------------------------
// /query — LLM parse + aggregate
// -----------------------------------------------------------------------

export const query = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/analysis/query",
    auth: true,
  },
  async (req: QueryRequest): Promise<AnalysisResult> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    // Rate-limit per user — each call hits llm-service. The /aggregate
    // endpoint (no LLM) is deliberately exempt.
    // See docs/finance-rate-limiting.md §2.
    checkRateLimit(`analysis-query:${auth.userID}`, {
      maxAttempts: 30,
      windowMs: 10 * 60_000,
      message: "Too many analysis queries.",
    });

    if (typeof req.question !== "string" || req.question.trim().length === 0) {
      throw APIError.invalidArgument("question must be a non-empty string");
    }

    // Load user-tag vocabulary — the LLM is constrained to these names.
    const tagRows = await db
      .select({ name: financeTag.name })
      .from(financeTag)
      .where(eq(financeTag.source, "user"));
    const availableTags = tagRows.map((r) => r.name).sort();

    let ast: AnalysisAst;
    try {
      ast = await parseAnalysisQuery(req.question, availableTags, {
        timespanHint: req.timespanHint,
      });
    } catch (err) {
      if (err instanceof LlmServiceUnavailableError) {
        throw APIError.unavailable(
          "llm-service unavailable — retry later or edit the AST manually",
        );
      }
      throw err;
    }

    const aggregates = await runAggregate(ast, auth, req.accountIds);
    return { ast, ...aggregates };
  },
);

// -----------------------------------------------------------------------
// /aggregate — run directly against a supplied AST
// -----------------------------------------------------------------------

export const aggregate = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/analysis/aggregate",
    auth: true,
  },
  async (req: AggregateRequest): Promise<AnalysisResult> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const ast = validateAst(req.ast);
    const aggregates = await runAggregate(ast, auth, req.accountIds);
    return { ast, ...aggregates };
  },
);

// -----------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------

function validateAst(raw: unknown): AnalysisAst {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw APIError.invalidArgument("ast must be an object");
  }
  const o = raw as Record<string, unknown>;
  const tags = Array.isArray(o.tags)
    ? o.tags.filter((t): t is string => typeof t === "string")
    : [];
  const op = o.op === "OR" ? "OR" : "AND";
  const result: AnalysisAst = { tags, op };
  if (
    o.timespan &&
    typeof o.timespan === "object" &&
    !Array.isArray(o.timespan)
  ) {
    const t = o.timespan as Record<string, unknown>;
    if (typeof t.from === "string" && typeof t.to === "string") {
      result.timespan = { from: t.from.slice(0, 10), to: t.to.slice(0, 10) };
    }
  }
  if (
    o.amountRange &&
    typeof o.amountRange === "object" &&
    !Array.isArray(o.amountRange)
  ) {
    const a = o.amountRange as Record<string, unknown>;
    const amountRange: { min?: number; max?: number } = {};
    if (typeof a.min === "number" && Number.isFinite(a.min)) amountRange.min = a.min;
    if (typeof a.max === "number" && Number.isFinite(a.max)) amountRange.max = a.max;
    if (amountRange.min !== undefined || amountRange.max !== undefined) {
      result.amountRange = amountRange;
    }
  }
  return result;
}

async function runAggregate(
  ast: AnalysisAst,
  auth: { userID: string; permissions: string[] },
  restrictAccountIds: number[] | undefined,
): Promise<Omit<AnalysisResult, "ast">> {
  const filter = await buildFilter(ast, auth, restrictAccountIds);

  const [totalRow] = (await db.execute(sql`
    SELECT
      COALESCE(SUM(amount), 0) AS sum,
      COUNT(*)::int AS count,
      COALESCE(AVG(amount), 0) AS avg
    FROM finance_transaction t
    WHERE ${filter}
  `)).rows as Array<{ sum: string | number; count: number; avg: string | number }>;

  const byMonthRows = (await db.execute(sql`
    SELECT
      TO_CHAR(date_trunc('month', booking_date), 'YYYY-MM') AS month,
      COALESCE(SUM(amount), 0) AS sum,
      COUNT(*)::int AS count
    FROM finance_transaction t
    WHERE ${filter}
    GROUP BY month
    ORDER BY month
  `)).rows as Array<{ month: string; sum: string | number; count: number }>;

  const topRows = (await db.execute(sql`
    SELECT
      COALESCE(counterparty, '(ohne Gegenseite)') AS name,
      COALESCE(SUM(amount), 0) AS sum,
      COUNT(*)::int AS count
    FROM finance_transaction t
    WHERE ${filter}
    GROUP BY name
    ORDER BY ABS(SUM(amount)) DESC
    LIMIT 10
  `)).rows as Array<{ name: string; sum: string | number; count: number }>;

  return {
    total: {
      sum: String(totalRow?.sum ?? "0"),
      count: totalRow?.count ?? 0,
      avg: String(totalRow?.avg ?? "0"),
    },
    byMonth: byMonthRows.map((r) => ({
      month: r.month,
      sum: String(r.sum),
      count: r.count,
    })),
    topCounterparties: topRows.map((r) => ({
      name: r.name,
      sum: String(r.sum),
      count: r.count,
    })),
  };
}

/**
 * Builds the shared SQL WHERE fragment. Ties together:
 *   - tag filter (AND / OR with user-source tags)
 *   - timespan filter
 *   - amount range
 *   - ACL filter for non-admins
 *   - optional caller-supplied accountIds restriction
 */
async function buildFilter(
  ast: AnalysisAst,
  auth: { userID: string; permissions: string[] },
  restrictAccountIds: number[] | undefined,
): Promise<SQLWrapper> {
  const parts: SQLWrapper[] = [sql`TRUE`];

  // Tag filter
  if (ast.tags.length > 0) {
    const tagList = sql.join(
      ast.tags.map((t) => sql`${t}`),
      sql`, `,
    );
    if (ast.op === "AND") {
      parts.push(sql`t.id IN (
        SELECT tt.transaction_id
        FROM finance_tag_transaction tt
        JOIN finance_tag tg ON tg.id = tt.tag_id
        WHERE tg.source = 'user' AND tg.name IN (${tagList})
        GROUP BY tt.transaction_id
        HAVING COUNT(DISTINCT tg.name) = ${ast.tags.length}
      )`);
    } else {
      parts.push(sql`t.id IN (
        SELECT tt.transaction_id
        FROM finance_tag_transaction tt
        JOIN finance_tag tg ON tg.id = tt.tag_id
        WHERE tg.source = 'user' AND tg.name IN (${tagList})
      )`);
    }
  }

  // Timespan
  if (ast.timespan) {
    parts.push(sql`t.booking_date >= ${ast.timespan.from}`);
    parts.push(sql`t.booking_date <= ${ast.timespan.to}`);
  }

  // Amount range
  if (ast.amountRange?.min !== undefined) {
    parts.push(sql`t.amount >= ${ast.amountRange.min}`);
  }
  if (ast.amountRange?.max !== undefined) {
    parts.push(sql`t.amount <= ${ast.amountRange.max}`);
  }

  // ACL filter
  if (!auth.permissions.includes("finance.admin")) {
    const rows = await db
      .select({ id: financeAccountAccess.account_id })
      .from(financeAccountAccess)
      .where(eq(financeAccountAccess.user_id, Number(auth.userID)));
    const accessible = rows.map((r) => r.id);
    if (accessible.length === 0) {
      // Empty set — short-circuit to match no rows.
      return sql`FALSE`;
    }
    const idList = sql.join(
      accessible.map((id) => sql`${id}`),
      sql`, `,
    );
    parts.push(sql`t.account_id IN (${idList})`);
  }

  // Optional caller-supplied accountIds (intersected with ACL above)
  if (restrictAccountIds && restrictAccountIds.length > 0) {
    const idList = sql.join(
      restrictAccountIds.map((id) => sql`${id}`),
      sql`, `,
    );
    parts.push(sql`t.account_id IN (${idList})`);
  }

  return sql.join(parts, sql` AND `);
}
