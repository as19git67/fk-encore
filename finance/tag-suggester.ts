/**
 * AI-tag suggestion pipeline for new finance transactions.
 *
 * Called synchronously after each manual / imported / FinTS-synced
 * INSERT into finance_transaction. The pipeline is best-effort: any
 * failure (llm-service down, embedding returns weird shape, Postgres
 * write conflict) is logged and swallowed — the transaction stays
 * untagged, and `POST /finance/tags/suggest` (Etappe 5 batch
 * endpoint, below) can retry later.
 *
 * Steps:
 *   1. Build an embedding from "<counterparty>|<purpose>|<sign>".
 *   2. Persist into finance_transaction_embedding so future neighbours
 *      see this row too.
 *   3. Nearest-neighbour lookup: 20 closest neighbours among
 *      transactions that ALREADY carry at least one user-tag. Cosine
 *      distance via the HNSW index from migration 0044.
 *   4. Call llm-client.suggestTags with the 20 examples' tag lists.
 *   5. Filter: only keep tags that appear in at least one example
 *      (defence-in-depth — the prompt asks for this but we verify).
 *   6. Filter: drop confidences < MIN_CONFIDENCE.
 *   7. Upsert each accepted tag as source='ai' and link it to the
 *      transaction (unless a user-variant already covers the same
 *      name on the same transaction).
 *
 * Architecture: docs/finance-tagging-and-ai.md §3.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { enqueueTagSuggestion } from "./tag-queue";
import { triggerTagWorker } from "./tag-worker";

import { requirePermission } from "../user/auth-handler";
import { checkRateLimit } from "../user/rateLimiter";
import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeTag,
  financeTagBlocklist,
  financeTagTransaction,
  financeTransaction,
} from "../db/schema";
import {
  embed,
  suggestTags,
  LlmServiceUnavailableError,
  type TagSuggestion,
} from "./llm-client";

console.log("[boot] finance/tag-suggester.ts: all imports resolved");

// -----------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------

const NEAREST_NEIGHBOUR_K = 20;
const MIN_CONFIDENCE = 0.3;
const MAX_SUGGESTIONS_PER_TX = 5;

// -----------------------------------------------------------------------
// Core pipeline
// -----------------------------------------------------------------------

/**
 * Annotates a single transaction with AI tag suggestions. Safe to
 * call from inside an INSERT path — returns `false` on any failure
 * without throwing.
 */
export async function suggestTagsForTransaction(
  transactionId: number,
): Promise<boolean> {
  try {
    const [tx] = await db
      .select()
      .from(financeTransaction)
      .where(eq(financeTransaction.id, transactionId))
      .limit(1);
    if (!tx) return false;

    const inputText = buildEmbedText(tx);

    // 1 + 2 — embed + persist
    // Re-throw LlmServiceUnavailableError so the worker defers the job
    // for a later retry instead of marking it done silently.
    let vector: number[];
    try {
      vector = await embed(inputText);
    } catch (err) {
      logSkip(transactionId, "embed failed", err);
      throw err;
    }
    await upsertEmbedding(transactionId, vector);

    // 3 — nearest neighbours with at least one user tag
    const neighbours = await loadNeighbours(transactionId, vector);
    if (neighbours.length === 0) {
      // Empty corpus is fine — first few transactions just won't get
      // AI suggestions. Next time will.
      return true;
    }

    // 4 — ask the LLM
    let suggestions: TagSuggestion[];
    try {
      suggestions = await suggestTags({
        transaction: {
          purpose: tx.purpose,
          counterparty: tx.counterparty,
          amount: tx.amount,
          currency_code: tx.currency_code,
          sign: Number(tx.amount) >= 0 ? "credit" : "debit",
          entry_text: tx.entry_text ?? null,
          originator_name: tx.originator_name ?? null,
          recipient_name: tx.recipient_name ?? null,
          mandate_ref: tx.mandate_ref ?? null,
          creditor_id: tx.creditor_id ?? null,
        },
        examples: neighbours.map((n) => ({
          purpose: n.purpose,
          counterparty: n.counterparty,
          amount: n.amount,
          sign: Number(n.amount) >= 0 ? "credit" : "debit",
          entry_text: n.entry_text,
          originator_name: n.originator_name,
          recipient_name: n.recipient_name,
          mandate_ref: n.mandate_ref,
          creditor_id: n.creditor_id,
          user_tags: n.user_tags,
        })),
      });
    } catch (err) {
      logSkip(transactionId, "suggestTags failed", err);
      throw err;
    }

    // 5 — restrict to the vocabulary seen in examples
    const allowed = new Set<string>();
    for (const n of neighbours) for (const t of n.user_tags) allowed.add(t);

    // 6 — confidence + count cap, then dedup by name (highest confidence wins)
    const byName = new Map<string, TagSuggestion>();
    for (const s of suggestions) {
      if (!allowed.has(s.tag)) continue;
      if (s.confidence < MIN_CONFIDENCE) continue;
      const prev = byName.get(s.tag);
      if (!prev || s.confidence > prev.confidence) {
        byName.set(s.tag, s);
      }
    }
    const accepted = [...byName.values()]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_SUGGESTIONS_PER_TX);
    if (accepted.length === 0) return true;

    // 6b — drop suggestions the user has previously rejected for this
    // (account, counterparty) pair so the LLM doesn't keep re-emitting
    // them. Done after the LLM call: the model is allowed to suggest
    // freely; we just refuse to persist what's been blocked.
    const blocked = await loadBlocklistFor(tx);
    const filtered = blocked.size === 0
      ? accepted
      : accepted.filter((s) => !blocked.has(s.tag));
    if (filtered.length === 0) return true;

    // 7 — persist as source='ai'
    await persistAiTags(transactionId, filtered);
    return true;
  } catch (err) {
    if (err instanceof LlmServiceUnavailableError) throw err;
    logSkip(transactionId, "tag-suggester crashed", err);
    return false;
  }
}

// -----------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------

function buildEmbedText(
  tx: typeof financeTransaction.$inferSelect,
): string {
  const sign = Number(tx.amount) >= 0 ? "credit" : "debit";
  // Include all structured SEPA fields alongside purpose so that
  // finanzkraft-imported transactions (where those fields were stripped
  // from the purpose text and stored in dedicated columns) produce
  // embeddings comparable to FinTS-sourced transactions (where the raw
  // purpose still contains the SEPA tags inline).
  return [
    tx.counterparty ?? "",
    tx.purpose ?? "",
    tx.entry_text ?? "",
    tx.originator_name ?? "",
    tx.recipient_name ?? "",
    tx.mandate_ref ?? "",
    tx.creditor_id ?? "",
    sign,
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" | ");
}

/**
 * Canonical key for the (account, counterparty) blocklist scope. Lowercased
 * and trimmed so minor textual differences ("Edeka" vs " edeka ") don't
 * defeat the block. Cash transactions (no counterparty) collapse to "".
 *
 * Exported so the reject endpoint uses the exact same key the suggester
 * looks up — drift here would silently break the feature.
 */
export function normalizeCounterparty(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

async function loadBlocklistFor(
  tx: typeof financeTransaction.$inferSelect,
): Promise<Set<string>> {
  const ctp = normalizeCounterparty(tx.counterparty);
  const rows = await db
    .select({ tag_name: financeTagBlocklist.tag_name })
    .from(financeTagBlocklist)
    .where(
      and(
        eq(financeTagBlocklist.account_id, tx.account_id),
        eq(financeTagBlocklist.counterparty_norm, ctp),
      ),
    );
  return new Set(rows.map((r) => r.tag_name));
}

/** Upsert via ON CONFLICT so re-runs on the same transaction stay idempotent. */
async function upsertEmbedding(
  transactionId: number,
  vector: number[],
): Promise<void> {
  const literal = `[${vector.join(",")}]`;
  await db.execute(
    sql`INSERT INTO finance_transaction_embedding (transaction_id, embedding)
        VALUES (${transactionId}, ${literal}::vector)
        ON CONFLICT (transaction_id) DO UPDATE
          SET embedding = EXCLUDED.embedding,
              created_at = now()`,
  );
}

interface NeighbourRow {
  id: number;
  purpose: string | null;
  counterparty: string | null;
  amount: string;
  entry_text: string | null;
  originator_name: string | null;
  recipient_name: string | null;
  mandate_ref: string | null;
  creditor_id: string | null;
  user_tags: string[];
}

/**
 * Loads the K nearest neighbours (cosine distance) among transactions
 * OTHER than `skipId` that have at least one user-tag. Aggregates the
 * user-tag names alongside for the prompt.
 *
 * Uses raw SQL because (a) pgvector's `<=>` operator has no drizzle
 * surface and (b) the subquery/aggregate combination is clearer as
 * SQL than as a chain of select builders.
 */
async function loadNeighbours(
  skipId: number,
  vector: number[],
): Promise<NeighbourRow[]> {
  const literal = `[${vector.join(",")}]`;
  const rows = (await db.execute(
    sql`
      WITH nearest AS (
        SELECT e.transaction_id, e.embedding <=> ${literal}::vector AS distance
        FROM finance_transaction_embedding e
        WHERE e.transaction_id <> ${skipId}
          AND EXISTS (
            SELECT 1 FROM finance_tag_transaction tt
            JOIN finance_tag t ON t.id = tt.tag_id
            WHERE tt.transaction_id = e.transaction_id
              AND t.source = 'user'
          )
        ORDER BY e.embedding <=> ${literal}::vector
        LIMIT ${NEAREST_NEIGHBOUR_K}
      )
      SELECT tx.id, tx.purpose, tx.counterparty, tx.amount,
             tx.entry_text, tx.originator_name, tx.recipient_name,
             tx.mandate_ref, tx.creditor_id,
             COALESCE(
               ARRAY_AGG(DISTINCT t.name ORDER BY t.name)
                 FILTER (WHERE t.source = 'user'),
               ARRAY[]::text[]
             ) AS user_tags
      FROM nearest n
      JOIN finance_transaction tx ON tx.id = n.transaction_id
      LEFT JOIN finance_tag_transaction tt ON tt.transaction_id = tx.id
      LEFT JOIN finance_tag t ON t.id = tt.tag_id
      GROUP BY tx.id, tx.purpose, tx.counterparty, tx.amount,
               tx.entry_text, tx.originator_name, tx.recipient_name,
               tx.mandate_ref, tx.creditor_id, n.distance
      ORDER BY n.distance
    `,
  )) as unknown as { rows?: NeighbourRow[] } | NeighbourRow[];

  // node-postgres returns { rows: [...] }; older driver paths returned
  // the array directly — handle both for safety.
  const extracted = Array.isArray(rows)
    ? rows
    : (rows.rows as NeighbourRow[] | undefined) ?? [];

  return extracted.map((r) => ({
    id: r.id,
    purpose: r.purpose,
    counterparty: r.counterparty,
    amount: r.amount,
    entry_text: r.entry_text ?? null,
    originator_name: r.originator_name ?? null,
    recipient_name: r.recipient_name ?? null,
    mandate_ref: r.mandate_ref ?? null,
    creditor_id: r.creditor_id ?? null,
    user_tags: Array.isArray(r.user_tags) ? r.user_tags : [],
  }));
}

async function persistAiTags(
  transactionId: number,
  suggestions: TagSuggestion[],
): Promise<void> {
  // Tags already attached to this transaction as user-variants — we
  // don't also emit an AI suggestion for them.
  const existingUserJoin = await db
    .select({ name: financeTag.name })
    .from(financeTagTransaction)
    .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
    .where(
      and(
        eq(financeTagTransaction.transaction_id, transactionId),
        eq(financeTag.source, "user"),
      ),
    );
  const blocked = new Set(existingUserJoin.map((r) => r.name));

  for (const s of suggestions) {
    if (blocked.has(s.tag)) continue;

    // Upsert the AI-variant tag
    let [aiTag] = await db
      .select({ id: financeTag.id })
      .from(financeTag)
      .where(and(eq(financeTag.name, s.tag), eq(financeTag.source, "ai")))
      .limit(1);
    if (!aiTag) {
      const inserted = await db
        .insert(financeTag)
        .values({ name: s.tag, source: "ai" })
        .returning({ id: financeTag.id });
      aiTag = inserted[0];
    }

    // Check existing join; only replace if new confidence is strictly higher
    const [existing] = await db
      .select({ confidence: financeTagTransaction.confidence })
      .from(financeTagTransaction)
      .where(
        and(
          eq(financeTagTransaction.tag_id, aiTag.id),
          eq(financeTagTransaction.transaction_id, transactionId),
        ),
      )
      .limit(1);

    const newConfidence = s.confidence.toFixed(3);
    if (!existing) {
      await db.insert(financeTagTransaction).values({
        tag_id: aiTag.id,
        transaction_id: transactionId,
        confidence: newConfidence,
      });
    } else if (
      existing.confidence === null ||
      Number(existing.confidence) < s.confidence
    ) {
      await db
        .update(financeTagTransaction)
        .set({ confidence: newConfidence })
        .where(
          and(
            eq(financeTagTransaction.tag_id, aiTag.id),
            eq(financeTagTransaction.transaction_id, transactionId),
          ),
        );
    }
  }
}

function logSkip(txId: number, what: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(
    `[finance.ai] suggest skipped for tx=${txId}: ${what}: ${msg}`,
  );
  if (err instanceof LlmServiceUnavailableError) {
    // already classified — no need to print the stack
    return;
  }
}

// -----------------------------------------------------------------------
// Batch endpoint for backfills (covers the non-user-specific import
// from Etappe 7 — see docs/finance-tagging-and-ai.md §3.3 Trigger B).
// -----------------------------------------------------------------------

interface SuggestBatchParams {
  accountId?: number;
  from?: string;
  to?: string;
  limit?: number;
}

interface SuggestBatchResponse {
  attempted: number;
  succeeded: number;
}

export const suggestTagsBatch = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/tags/suggest",
    auth: true,
  },
  async (p: SuggestBatchParams): Promise<SuggestBatchResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    // Batch runs can fan out to many llm-service calls. Strict cap.
    // See docs/finance-rate-limiting.md §2.
    checkRateLimit(`tag-suggest-batch:${auth.userID}`, {
      maxAttempts: 5,
      windowMs: 60 * 60_000,
      message: "Too many batch tag-suggestion runs.",
    });

    // ACL filter — non-admin users may only run the suggester over
    // transactions on accounts they can read.
    const conds = [];
    if (!auth.permissions.includes("finance.admin")) {
      const accessible = await db
        .select({ id: financeAccountAccess.account_id })
        .from(financeAccountAccess)
        .where(eq(financeAccountAccess.user_id, Number(auth.userID)));
      const ids = accessible.map((a) => a.id);
      if (ids.length === 0) return { attempted: 0, succeeded: 0 };
      conds.push(inArray(financeTransaction.account_id, ids));
    }

    if (p.accountId !== undefined) {
      // Still has to be accessible — merge with the ACL filter by simple
      // account-existence check.
      const [row] = await db
        .select({ id: financeAccount.id })
        .from(financeAccount)
        .where(eq(financeAccount.id, p.accountId))
        .limit(1);
      if (!row) throw APIError.notFound(`account ${p.accountId} not found`);
      conds.push(eq(financeTransaction.account_id, p.accountId));
    }
    if (p.from) conds.push(sql`${financeTransaction.booking_date} >= ${p.from}`);
    if (p.to) conds.push(sql`${financeTransaction.booking_date} <= ${p.to}`);

    const limit = Math.min(Math.max(p.limit ?? 100, 1), 1_000);
    const rows = await db
      .select({ id: financeTransaction.id })
      .from(financeTransaction)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(financeTransaction.booking_date))
      .limit(limit);

    const userId = Number(auth.userID);
    let enqueued = 0;
    for (const r of rows) {
      try {
        await enqueueTagSuggestion(r.id, userId);
        enqueued++;
      } catch (err) {
        console.error(`[finance] failed to enqueue tag suggestion for tx=${r.id}:`, (err as Error).message);
      }
    }
    if (enqueued > 0) triggerTagWorker();
    return { attempted: rows.length, succeeded: enqueued };
  },
);
