/**
 * Automatic AI-powered finance analysis suggestions (Finanz-Rückblicke).
 *
 * Runs daily via local-cron. For each user with finance transactions:
 *   1. Collects tag/counterparty summaries from recent data
 *   2. Asks the LLM for interesting analysis suggestions
 *   3. Upserts into finance_saved_analysis with source='ai' + fingerprint dedup
 *   4. Pre-computes aggregate summaries
 *
 * Deduplication: each suggestion gets a fingerprint (stable hash of the
 * normalised AST). The unique index on (user_id, fingerprint) prevents
 * duplicates. On conflict the row is updated (name/summary refreshed,
 * seen_at preserved so the user's read-state isn't lost).
 */

import { createHash } from "node:crypto";
import { sql, eq, and, isNotNull } from "drizzle-orm";
import log from "encore.dev/log";

import db from "../db/database";
import {
  financeAccountAccess,
  financeTag,
  financeSavedAnalysis,
  type SavedAnalysisSummary,
} from "../db/schema";
import {
  generateAnalysisSuggestions,
  resolveRelativeTimespan,
  isLlmServiceHealthy,
  type AnalysisAst,
  type SuggestAnalysesInput,
} from "./llm-client";

console.log("[boot] finance/analysis-suggestions.ts: all imports resolved");

// -----------------------------------------------------------------------
// Fingerprint
// -----------------------------------------------------------------------

function computeFingerprint(ast: AnalysisAst): string {
  const normalized: Record<string, unknown> = {};
  normalized.tags = [...ast.tags].sort();
  normalized.op = ast.op;
  if (ast.kind) normalized.kind = ast.kind;
  if (ast.relativeTimespan) {
    normalized.relativeTimespan = ast.relativeTimespan;
  } else if (ast.timespan) {
    normalized.timespan = ast.timespan;
  }
  if (ast.amountRange) normalized.amountRange = ast.amountRange;
  if (ast.tagGroups) {
    normalized.tagGroups = ast.tagGroups.map((g) => ({
      tags: [...g.tags].sort(),
      op: g.op,
    }));
    normalized.groupOp = ast.groupOp;
  }
  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 32);
}

// -----------------------------------------------------------------------
// Per-user generation
// -----------------------------------------------------------------------

async function generateForUser(userId: number): Promise<number> {
  const accessRows = await db
    .select({ account_id: financeAccountAccess.account_id })
    .from(financeAccountAccess)
    .where(eq(financeAccountAccess.user_id, userId));
  const accountIds = accessRows.map((r) => r.account_id);
  if (accountIds.length === 0) return 0;

  const idList = sql.join(accountIds.map((id) => sql`${id}`), sql`, `);

  const tagRows = await db
    .select({ name: financeTag.name })
    .from(financeTag)
    .where(eq(financeTag.source, "user"));
  const availableTags = tagRows.map((r) => r.name).sort();
  if (availableTags.length === 0) return 0;

  const tagSummary = (
    await db.execute(sql`
      SELECT
        tg.name AS tag,
        COALESCE(SUM(t.amount), 0) AS sum,
        COUNT(*)::int AS count
      FROM finance_transaction t
      JOIN finance_tag_transaction tt ON tt.transaction_id = t.id
      JOIN finance_tag tg ON tg.id = tt.tag_id AND tg.source = 'user'
      WHERE t.account_id IN (${idList})
        AND t.booking_date >= (CURRENT_DATE - INTERVAL '365 days')
      GROUP BY tg.name
      ORDER BY ABS(SUM(t.amount)) DESC
      LIMIT 30
    `)
  ).rows as Array<{ tag: string; sum: string | number; count: number }>;

  const topCounterparties = (
    await db.execute(sql`
      SELECT
        COALESCE(counterparty, '(ohne)') AS name,
        COALESCE(SUM(amount), 0) AS sum,
        COUNT(*)::int AS count
      FROM finance_transaction
      WHERE account_id IN (${idList})
        AND booking_date >= (CURRENT_DATE - INTERVAL '365 days')
      GROUP BY name
      ORDER BY ABS(SUM(amount)) DESC
      LIMIT 15
    `)
  ).rows as Array<{ name: string; sum: string | number; count: number }>;

  const rangeRow = (
    await db.execute(sql`
      SELECT
        TO_CHAR(MIN(booking_date), 'YYYY-MM-DD') AS min_date,
        TO_CHAR(MAX(booking_date), 'YYYY-MM-DD') AS max_date
      FROM finance_transaction
      WHERE account_id IN (${idList})
    `)
  ).rows[0] as { min_date: string | null; max_date: string | null } | undefined;

  if (!rangeRow?.min_date || !rangeRow?.max_date) return 0;

  const existingRows = await db
    .select({ name: financeSavedAnalysis.name })
    .from(financeSavedAnalysis)
    .where(eq(financeSavedAnalysis.user_id, userId));
  const existingNames = existingRows.map((r) => r.name);

  const input: SuggestAnalysesInput = {
    availableTags,
    tagSummary: tagSummary.map((r) => ({
      tag: r.tag,
      sum: String(r.sum),
      count: r.count,
    })),
    topCounterparties: topCounterparties.map((r) => ({
      name: r.name,
      sum: String(r.sum),
      count: r.count,
    })),
    existingNames,
    dataRange: { from: rangeRow.min_date, to: rangeRow.max_date },
  };

  const suggestions = await generateAnalysisSuggestions(input);
  let upserted = 0;

  for (const s of suggestions) {
    const fingerprint = computeFingerprint(s.ast);

    const ast = s.ast.relativeTimespan
      ? { ...s.ast, timespan: resolveRelativeTimespan(s.ast.relativeTimespan) }
      : s.ast;

    let summary: SavedAnalysisSummary | null = null;
    try {
      summary = await computeSummary(ast, accountIds);
    } catch {
      // non-critical — card just won't show a preview number
    }

    // Skip suggestions that match zero transactions
    if (summary && summary.count === 0) continue;

    await db.execute(sql`
      INSERT INTO finance_saved_analysis
        (user_id, name, question, ast, source, summary, fingerprint, created_at, updated_at)
      VALUES (
        ${userId}, ${s.name}, ${s.question},
        ${JSON.stringify(s.ast)}::jsonb, 'ai',
        ${summary ? JSON.stringify(summary) : null}::jsonb,
        ${fingerprint}, NOW(), NOW()
      )
      ON CONFLICT (user_id, fingerprint) WHERE fingerprint IS NOT NULL
      DO UPDATE SET
        name = EXCLUDED.name,
        summary = EXCLUDED.summary,
        updated_at = NOW()
    `);
    upserted++;
  }

  return upserted;
}

async function computeSummary(
  ast: AnalysisAst,
  accountIds: number[],
): Promise<SavedAnalysisSummary> {
  const parts: ReturnType<typeof sql>[] = [sql`TRUE`];

  if (ast.tags.length > 0) {
    const tagList = sql.join(ast.tags.map((t) => sql`${t}`), sql`, `);
    if (ast.op === "AND") {
      parts.push(sql`t.id IN (
        SELECT tt.transaction_id FROM finance_tag_transaction tt
        JOIN finance_tag tg ON tg.id = tt.tag_id
        WHERE tg.source = 'user' AND tg.name IN (${tagList})
        GROUP BY tt.transaction_id
        HAVING COUNT(DISTINCT tg.name) = ${ast.tags.length}
      )`);
    } else {
      parts.push(sql`t.id IN (
        SELECT tt.transaction_id FROM finance_tag_transaction tt
        JOIN finance_tag tg ON tg.id = tt.tag_id
        WHERE tg.source = 'user' AND tg.name IN (${tagList})
      )`);
    }
  }
  if (ast.timespan) {
    parts.push(sql`t.booking_date >= ${ast.timespan.from}`);
    parts.push(sql`t.booking_date <= ${ast.timespan.to}`);
  }
  if (ast.amountRange?.min !== undefined) {
    parts.push(sql`t.amount >= ${ast.amountRange.min}`);
  }
  if (ast.amountRange?.max !== undefined) {
    parts.push(sql`t.amount <= ${ast.amountRange.max}`);
  }
  if (accountIds.length > 0) {
    const idList = sql.join(accountIds.map((id) => sql`${id}`), sql`, `);
    parts.push(sql`t.account_id IN (${idList})`);
  }

  const filter = sql.join(parts, sql` AND `);
  const [row] = (
    await db.execute(sql`
      SELECT
        COALESCE(SUM(amount), 0) AS sum,
        COUNT(*)::int AS count,
        COALESCE(AVG(amount), 0) AS avg
      FROM finance_transaction t
      WHERE ${filter}
    `)
  ).rows as Array<{ sum: string | number; count: number; avg: string | number }>;

  return {
    sum: String(row?.sum ?? "0"),
    count: row?.count ?? 0,
    avg: String(row?.avg ?? "0"),
  };
}

// -----------------------------------------------------------------------
// All-users entry point
// -----------------------------------------------------------------------

let running: Promise<{ users: number; suggestions: number }> | null = null;

export async function generateSuggestionsForAllUsers(): Promise<{
  users: number;
  suggestions: number;
  skipped?: boolean;
}> {
  if (running) {
    log.warn("analysis-suggestions: already running — skipping");
    return { users: 0, suggestions: 0, skipped: true };
  }

  const healthy = await isLlmServiceHealthy();
  if (!healthy) {
    log.info("analysis-suggestions: llm-service not reachable — skipping");
    return { users: 0, suggestions: 0, skipped: true };
  }

  running = (async () => {
    const userRows = (
      await db.execute(sql`
        SELECT DISTINCT user_id
        FROM finance_account_access
        WHERE user_id IS NOT NULL
      `)
    ).rows as Array<{ user_id: number }>;

    let totalSuggestions = 0;
    for (const row of userRows) {
      try {
        const count = await generateForUser(row.user_id);
        totalSuggestions += count;
        if (count > 0) {
          log.info("analysis-suggestions: generated", {
            user_id: row.user_id,
            count,
          });
        }
      } catch (err: any) {
        log.error("analysis-suggestions: user failed", {
          user_id: row.user_id,
          err: err?.message ?? String(err),
        });
      }
    }
    return { users: userRows.length, suggestions: totalSuggestions };
  })();

  try {
    const result = await running;
    return result;
  } finally {
    running = null;
  }
}

export { computeFingerprint as _computeFingerprint };
export { generateForUser as _generateForUser };
