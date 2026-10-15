/**
 * Write actions as proposals the user confirms (documentation/plans/
 * ki-assistent.md, stage 4, #1529).
 *
 * A write tool never acts. Its runner prepares the action — validates the
 * arguments and resolves what they point at, e.g. the 143 photo ids an album
 * would get — and stores that as a proposal. The chat shows a card; only
 * `POST /assistant/proposals/:id/execute` runs it, as the user who asked,
 * through the services' own endpoints, so their permission checks apply a
 * second time. A proposal runs at most once and only for its own user.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../db/database";
import { assistantProposal } from "../db/schema";
import type { JsonSchema, ResultBlock, ToolContext, ToolOutcome, ToolSpec } from "./types";

/** What a write tool would do, ready to store. */
export interface PreparedAction {
  /** One sentence for the card: "Album ‚Favoriten 2025‘ anlegen und 143 Fotos hinzufügen". */
  summary: string;
  /** Exactly what `execute` will get; resolved now, so the card is the truth. */
  arguments: Record<string, unknown>;
  /** How many objects the action touches, for the card. */
  count?: number;
}

/** What an executed action did. */
export interface ActionResult {
  summary: string;
  /** Where the result can be seen, e.g. `/fotos/alben/12`. */
  route?: string;
  details?: Record<string, unknown>;
}

export interface WriteToolDefinition {
  name: string;
  summary: string;
  permissions: string[];
  parameters: JsonSchema;
  prepare(args: Record<string, unknown>, ctx: ToolContext): Promise<PreparedAction>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ActionResult>;
}

export type ProposalStatus = "pending" | "executing" | "executed" | "discarded";

/**
 * One row of a `proposal` block, as the client renders the card. No index
 * signature: it is also an endpoint response, and Encore's schema parser
 * rejects those.
 */
export interface ProposalRow {
  proposal_id: number;
  tool: string;
  summary: string;
  count: number | null;
  status: ProposalStatus;
  result_summary: string | null;
  result_route: string | null;
  error: string | null;
}

function proposalBlock(row: ProposalRow): ResultBlock {
  return { kind: "proposal", tool: row.tool, rows: [{ ...row }] };
}

/**
 * The catalog entry of a write tool: running it stores a proposal and tells
 * the model so in words it cannot mistake for "done".
 */
export function writeTool(def: WriteToolDefinition): ToolSpec {
  return {
    name: def.name,
    kind: "write",
    summary: def.summary,
    permissions: def.permissions,
    parameters: def.parameters,
    source: "hand",
    async run(args, ctx): Promise<ToolOutcome> {
      const prepared = await def.prepare(args, ctx);
      const [stored] = await db
        .insert(assistantProposal)
        .values({
          conversation_id: ctx.conversationId ?? null,
          user_id: Number(ctx.user.userID),
          tool: def.name,
          arguments: prepared.arguments,
          summary: prepared.summary,
        })
        .returning({ id: assistantProposal.id });
      const row: ProposalRow = {
        proposal_id: stored.id,
        tool: def.name,
        summary: prepared.summary,
        count: prepared.count ?? null,
        status: "pending",
        result_summary: null,
        result_route: null,
        error: null,
      };
      return {
        text: [
          `Proposal #${stored.id} created, NOT executed: ${prepared.summary}.`,
          "The user sees a card with \"Ausführen\" and \"Verwerfen\" and decides. Tell them what you proposed; never say it is done.",
        ].join("\n"),
        digest: `[earlier proposal #${stored.id}: ${prepared.summary}]`,
        rowCount: prepared.count ?? 1,
        block: proposalBlock(row),
      };
    },
  };
}

// ── deciding ──────────────────────────────────────────────────────────────

export class ProposalError extends Error {
  constructor(readonly reason: "not_found" | "decided", message: string) {
    super(message);
    this.name = "ProposalError";
  }
}

/**
 * Takes the proposal for this user, once: the status moves from `pending` to
 * `executing` in a single UPDATE, so a double click or a second tab finds
 * nothing to take. A failed action goes back to `pending` with its error, so
 * the user can try again after fixing what the error names.
 */
export async function executeProposal(
  id: number,
  ctx: ToolContext,
  tools: Map<string, WriteToolDefinition>,
): Promise<ProposalRow> {
  const userId = Number(ctx.user.userID);
  const [claimed] = await db
    .update(assistantProposal)
    .set({ status: "executing" })
    .where(and(
      eq(assistantProposal.id, id),
      eq(assistantProposal.user_id, userId),
      eq(assistantProposal.status, "pending"),
    ))
    .returning();
  if (!claimed) throw await refusal(id, userId);

  const def = tools.get(claimed.tool);
  try {
    if (!def) throw new Error(`the action ${claimed.tool} no longer exists`);
    if (!def.permissions.every((p) => ctx.user.permissions.includes(p))) {
      throw new Error("you no longer have the permission this action needs");
    }
    const result = await def.execute(claimed.arguments, { ...ctx, conversationId: claimed.conversation_id ?? undefined });
    const [done] = await db
      .update(assistantProposal)
      .set({ status: "executed", decided_at: sql`now()`, result: { ...result } })
      .where(eq(assistantProposal.id, id))
      .returning();
    return toRow(done);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const [back] = await db
      .update(assistantProposal)
      .set({ status: "pending", result: { error: message } })
      .where(eq(assistantProposal.id, id))
      .returning();
    return toRow(back);
  }
}

export async function discardProposal(id: number, ctx: ToolContext): Promise<ProposalRow> {
  const userId = Number(ctx.user.userID);
  const [row] = await db
    .update(assistantProposal)
    .set({ status: "discarded", decided_at: sql`now()` })
    .where(and(
      eq(assistantProposal.id, id),
      eq(assistantProposal.user_id, userId),
      eq(assistantProposal.status, "pending"),
    ))
    .returning();
  if (!row) throw await refusal(id, userId);
  return toRow(row);
}

async function refusal(id: number, userId: number): Promise<ProposalError> {
  const [row] = await db
    .select({ status: assistantProposal.status })
    .from(assistantProposal)
    .where(and(eq(assistantProposal.id, id), eq(assistantProposal.user_id, userId)))
    .limit(1);
  // Someone else's proposal reads as missing, not as "decided".
  if (!row) return new ProposalError("not_found", "proposal not found");
  return new ProposalError("decided", `proposal is already ${row.status}`);
}

export function toRow(row: typeof assistantProposal.$inferSelect): ProposalRow {
  const result = (row.result ?? {}) as { summary?: string; route?: string; error?: string };
  return {
    proposal_id: row.id,
    tool: row.tool,
    summary: row.summary,
    count: null,
    status: row.status,
    result_summary: row.status === "executed" ? result.summary ?? null : null,
    result_route: row.status === "executed" ? result.route ?? null : null,
    error: row.status === "pending" ? result.error ?? null : null,
  };
}

/**
 * Proposal cards keep the state they had when the answer was stored; this
 * brings them up to date for a conversation being reopened.
 */
export async function refreshProposalBlocks(blocks: ResultBlock[], userId: number): Promise<ResultBlock[]> {
  const ids = blocks
    .filter((b) => b.kind === "proposal")
    .flatMap((b) => b.rows.map((r) => Number(r.proposal_id)))
    .filter((n) => Number.isInteger(n));
  if (!ids.length) return blocks;
  const rows = await db
    .select()
    .from(assistantProposal)
    .where(and(inArray(assistantProposal.id, ids), eq(assistantProposal.user_id, userId)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return blocks.map((b) => b.kind !== "proposal" ? b : {
    ...b,
    rows: b.rows.map((r) => {
      const current = byId.get(Number(r.proposal_id));
      return current ? { ...toRow(current), count: (r.count as number | null) ?? null } : r;
    }),
  });
}
