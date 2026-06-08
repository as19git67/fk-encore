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
  resolveRelativeTimespan,
  LlmServiceUnavailableError,
  type AnalysisAst,
  type TagGroup,
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
  byPeriod: Array<{ period: string; sum: string; count: number }>;
  byTag: Array<{ tag: string; sum: string; count: number }>;
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

    const ast = resolveAstTimespan(validateAst(req.ast));
    const aggregates = await runAggregate(ast, auth, req.accountIds);
    return { ast, ...aggregates };
  },
);

// -----------------------------------------------------------------------
// /transactions — drill into the rows behind one tag of the breakdown
// -----------------------------------------------------------------------

interface TransactionsRequest {
  ast: AnalysisAst;
  /** The specific tag whose matching transactions to list. */
  tag: string;
  accountIds?: number[];
  limit?: number;
}

export interface AnalysisTransaction {
  id: number;
  bookingDate: string;
  amount: string;
  currency: string;
  counterparty: string | null;
  purpose: string | null;
}

interface TransactionsResponse {
  transactions: AnalysisTransaction[];
}

export const transactions = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/analysis/transactions",
    auth: true,
  },
  async (req: TransactionsRequest): Promise<TransactionsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    if (typeof req.tag !== "string" || req.tag.trim().length === 0) {
      throw APIError.invalidArgument("tag must be a non-empty string");
    }
    const tag = req.tag.trim();
    const ast = validateAst(req.ast);
    const limit =
      typeof req.limit === "number" && Number.isFinite(req.limit) && req.limit > 0
        ? Math.min(Math.floor(req.limit), 500)
        : 200;

    // Same filter the aggregate uses (tags / timespan / amount / ACL),
    // narrowed to the single tag the user clicked on.
    const filter = await buildFilter(ast, auth, req.accountIds);

    const rows = (await db.execute(sql`
      SELECT
        t.id,
        TO_CHAR(t.booking_date, 'YYYY-MM-DD') AS booking_date,
        t.amount,
        t.currency_code,
        t.counterparty,
        t.purpose
      FROM finance_transaction t
      WHERE ${filter}
        AND t.id IN (
          SELECT tt.transaction_id
          FROM finance_tag_transaction tt
          JOIN finance_tag tg ON tg.id = tt.tag_id
          WHERE tg.source = 'user' AND tg.name = ${tag}
        )
      ORDER BY t.booking_date DESC, t.id DESC
      LIMIT ${limit}
    `)).rows as Array<{
      id: number | string;
      booking_date: string;
      amount: string | number;
      currency_code: string;
      counterparty: string | null;
      purpose: string | null;
    }>;

    return {
      transactions: rows.map((r) => ({
        id: Number(r.id),
        bookingDate: r.booking_date,
        amount: String(r.amount),
        currency: r.currency_code,
        counterparty: r.counterparty,
        purpose: r.purpose,
      })),
    };
  },
);

// -----------------------------------------------------------------------
// /period-transactions — drill into the rows behind one period row
// -----------------------------------------------------------------------

interface PeriodTransactionsRequest {
  ast: AnalysisAst;
  period: string;
  accountIds?: number[];
  limit?: number;
}

export const periodTransactions = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/analysis/period-transactions",
    auth: true,
  },
  async (req: PeriodTransactionsRequest): Promise<TransactionsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    if (typeof req.period !== "string" || req.period.trim().length === 0) {
      throw APIError.invalidArgument("period must be a non-empty string");
    }
    const period = req.period.trim();
    const ast = resolveAstTimespan(validateAst(req.ast));
    const limit =
      typeof req.limit === "number" && Number.isFinite(req.limit) && req.limit > 0
        ? Math.min(Math.floor(req.limit), 500)
        : 200;

    const filter = await buildFilter(ast, auth, req.accountIds);

    // Determine the date range for this period
    const isYear = /^\d{4}$/.test(period);
    const periodFormat = isYear ? "YYYY" : "YYYY-MM";

    const rows = (await db.execute(sql`
      SELECT
        t.id,
        TO_CHAR(t.booking_date, 'YYYY-MM-DD') AS booking_date,
        t.amount,
        t.currency_code,
        t.counterparty,
        t.purpose
      FROM finance_transaction t
      WHERE ${filter}
        AND TO_CHAR(t.booking_date, ${periodFormat}) = ${period}
      ORDER BY t.booking_date DESC, t.id DESC
      LIMIT ${limit}
    `)).rows as Array<{
      id: number | string;
      booking_date: string;
      amount: string | number;
      currency_code: string;
      counterparty: string | null;
      purpose: string | null;
    }>;

    return {
      transactions: rows.map((r) => ({
        id: Number(r.id),
        bookingDate: r.booking_date,
        amount: String(r.amount),
        currency: r.currency_code,
        counterparty: r.counterparty,
        purpose: r.purpose,
      })),
    };
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
  if (o.kind === "event" || o.kind === "ongoing") {
    result.kind = o.kind;
  }
  if (o.interval === "year" || o.interval === "month") {
    result.interval = o.interval;
  }
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
  if (
    o.relativeTimespan &&
    typeof o.relativeTimespan === "object" &&
    !Array.isArray(o.relativeTimespan)
  ) {
    const rt = o.relativeTimespan as Record<string, unknown>;
    const validTypes = new Set([
      "this_year", "last_year", "last_n_years", "last_n_months",
      "this_month", "last_month",
    ]);
    if (typeof rt.type === "string" && validTypes.has(rt.type)) {
      result.relativeTimespan = { type: rt.type as any };
      if (typeof rt.n === "number" && Number.isFinite(rt.n) && rt.n > 0) {
        result.relativeTimespan.n = Math.floor(rt.n);
      }
    }
  }
  // Tag groups (UI-driven complex tag expressions)
  if (Array.isArray(o.tagGroups)) {
    const groups = (o.tagGroups as any[])
      .filter((g: any) => g && typeof g === "object" && Array.isArray(g.tags))
      .map((g: any) => ({
        tags: (g.tags as unknown[]).filter((t: unknown): t is string => typeof t === "string"),
        op: g.op === "OR" ? "OR" as const : "AND" as const,
      }))
      .filter((g: { tags: string[] }) => g.tags.length > 0);
    if (groups.length > 0) {
      result.tagGroups = groups;
      result.groupOp = o.groupOp === "OR" ? "OR" : "AND";
    }
  }
  return result;
}

function resolveAstTimespan(ast: AnalysisAst): AnalysisAst {
  if (ast.relativeTimespan) {
    return { ...ast, timespan: resolveRelativeTimespan(ast.relativeTimespan) };
  }
  return ast;
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

  const useYearly = ast.interval === "year";
  const truncUnit = useYearly ? sql`'year'` : sql`'month'`;
  const formatStr = useYearly ? "YYYY" : "YYYY-MM";

  const byPeriodRows = (await db.execute(sql`
    SELECT
      TO_CHAR(date_trunc(${truncUnit}, booking_date), ${formatStr}) AS period,
      COALESCE(SUM(amount), 0) AS sum,
      COUNT(*)::int AS count
    FROM finance_transaction t
    WHERE ${filter}
    GROUP BY period
    ORDER BY period
  `)).rows as Array<{ period: string; sum: string | number; count: number }>;

  // Breakdown by tag — groups the filtered rows by every user-tag they
  // carry. A transaction with multiple tags counts toward each of them
  // (this is an overview per tag, not a strict partition). The tags that
  // are part of the filter itself are excluded, since every matching row
  // carries them and they'd dominate the breakdown uninformatively. This
  // is what powers "of my Japan trip, X went to transport, Y to food…".
  const allFilterTags = ast.tagGroups && ast.tagGroups.length > 0
    ? ast.tagGroups.flatMap((g) => g.tags)
    : ast.tags;
  let tagExclusion = sql``;
  if (allFilterTags.length > 0) {
    const excludeList = sql.join(
      allFilterTags.map((t) => sql`${t}`),
      sql`, `,
    );
    tagExclusion = sql` AND tg.name NOT IN (${excludeList})`;
  }
  const byTagRows = (await db.execute(sql`
    SELECT
      tg.name AS tag,
      COALESCE(SUM(t.amount), 0) AS sum,
      COUNT(*)::int AS count
    FROM finance_transaction t
    JOIN finance_tag_transaction tt ON tt.transaction_id = t.id
    JOIN finance_tag tg ON tg.id = tt.tag_id AND tg.source = 'user'
    WHERE ${filter}${tagExclusion}
    GROUP BY tg.name
    ORDER BY ABS(SUM(t.amount)) DESC
    LIMIT 50
  `)).rows as Array<{ tag: string; sum: string | number; count: number }>;

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
    byPeriod: byPeriodRows.map((r) => ({
      period: r.period,
      sum: String(r.sum),
      count: r.count,
    })),
    byTag: byTagRows.map((r) => ({
      tag: r.tag,
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

  // Tag filter — grouped expressions take precedence over flat tags/op
  if (ast.tagGroups && ast.tagGroups.length > 0) {
    const groupFragments: SQLWrapper[] = ast.tagGroups.map((g: TagGroup) => {
      const tagList = sql.join(
        g.tags.map((t) => sql`${t}`),
        sql`, `,
      );
      if (g.op === "AND") {
        return sql`t.id IN (
          SELECT tt.transaction_id
          FROM finance_tag_transaction tt
          JOIN finance_tag tg ON tg.id = tt.tag_id
          WHERE tg.source = 'user' AND tg.name IN (${tagList})
          GROUP BY tt.transaction_id
          HAVING COUNT(DISTINCT tg.name) = ${g.tags.length}
        )`;
      } else {
        return sql`t.id IN (
          SELECT tt.transaction_id
          FROM finance_tag_transaction tt
          JOIN finance_tag tg ON tg.id = tt.tag_id
          WHERE tg.source = 'user' AND tg.name IN (${tagList})
        )`;
      }
    });
    const groupJoiner = ast.groupOp === "OR" ? sql` OR ` : sql` AND `;
    if (groupFragments.length === 1) {
      parts.push(groupFragments[0]);
    } else {
      parts.push(sql`(${sql.join(groupFragments, groupJoiner)})`);
    }
  } else if (ast.tags.length > 0) {
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
