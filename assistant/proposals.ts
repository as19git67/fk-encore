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
import { AFTER_EXECUTE, type JsonSchema, type ResultBlock, type ToolContext, type ToolOutcome, type ToolSpec } from "./types";
import type { CollageTextPosition, CollageTextSize } from "../photo/collage";

/** What a write tool would do, ready to store. */
export interface PreparedAction {
  /** One sentence for the card: "Album ‚Favoriten 2025‘ anlegen und 143 Fotos hinzufügen". */
  summary: string;
  /** Exactly what `execute` will get; resolved now, so the card is the truth. */
  arguments: Record<string, unknown>;
  /** How many objects the action touches, for the card. */
  count?: number;
  /** What the model may tell about the proposal beyond the summary — figures the server computed. */
  note?: string;
}

/** What an executed action did. */
export interface ActionResult {
  summary: string;
  /** Where the result can be seen, e.g. `/fotos/alben/12`. */
  route?: string;
  /** An API path the card downloads with the user's token, e.g. a report's PDF. */
  download?: string;
  details?: Record<string, unknown>;
}

export interface WriteToolDefinition {
  name: string;
  summary: string;
  permissions: string[];
  parameters: JsonSchema;
  prepare(args: Record<string, unknown>, ctx: ToolContext): Promise<PreparedAction>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ActionResult>;
  /** The editable letter the card shows, for a tool whose proposal the user may change (#1534). */
  draft?(args: Record<string, unknown>): LetterDraft;
  /** The stored arguments with the user's changes from the card applied. */
  edit?(args: Record<string, unknown>, edits: ProposalEdits): Record<string, unknown>;
  /** The text document the card shows, for a tool that files one. */
  preview?(args: Record<string, unknown>): TextDocumentPreview;
  /** The collage the card previews and lets the user change; `result` once it ran. */
  collage?(args: Record<string, unknown>, result: Record<string, unknown> | null): CollagePreview;
}

/** A photo of a collage, as the card draws it. */
export interface CollagePhoto {
  id: number;
  filename: string;
  auto_crop: { x: number; y: number } | null;
}

/** A collage as the card shows it: the photos in cell order, the layout and the caption. */
export interface CollagePreview {
  photos: CollagePhoto[];
  layout: string;
  text: string;
  text_position: CollageTextPosition;
  text_size: CollageTextSize;
  text_color: string;
  album_name: string | null;
  /** The filed collage, once "Ausführen" ran. */
  result: { photo_id: number; filename: string } | null;
}

/** What the user changed on a collage's card. */
export interface CollageEdits {
  layout?: string;
  text?: string;
  text_position?: CollageTextPosition;
  text_size?: CollageTextSize;
  text_color?: string;
}

/** A text document as the card shows it before it is filed. */
export interface TextDocumentPreview {
  title: string;
  markdown: string;
}

/** Where a confirmed letter goes besides the download. */
export type LetterDestination = "document" | "collection";

export interface LetterAttachment {
  id: number;
  title: string;
}

/** A letter as the card shows it for editing. */
export interface LetterDraft {
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  attachments: LetterAttachment[];
  /** Photos printed after the letter, one per page. */
  photos: LetterAttachment[];
  destinations: LetterDestination[];
  /** What the model could not fill in, as `[[…]]` in the text. */
  gaps: string[];
}

/** What the user changed on the card before "Ausführen". */
export interface ProposalEdits {
  sender?: string;
  recipient?: string;
  subject?: string;
  body?: string;
  destinations?: LetterDestination[];
  /**
   * The enclosures, in order: kept ones from the proposal and documents the
   * user added on the card. Visibility is checked again when the letter runs.
   */
  attachment_ids?: number[];
  /** The proposed photos the user kept enclosed. */
  photo_ids?: number[];
  /** A collage's layout and caption. */
  collage?: CollageEdits;
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
  result_download: string | null;
  error: string | null;
  /** Set for a letter: the fields the card lets the user change. */
  letter: LetterDraft | null;
  /** Set for a text document: what will be filed. */
  text_document: TextDocumentPreview | null;
  /** Set for a collage: what will be rendered, and afterwards the photo it became. */
  collage: CollagePreview | null;
  /**
   * What the assistant goes on with once the card ran — the rest of the
   * question that needs its result. The app asks it to continue right after
   * "Ausführen"; null when nothing waits on the card.
   */
  continuation: string | null;
}

/** Per tool, how its stored arguments become the card's editable letter. */
const drafters = new Map<string, (args: Record<string, unknown>) => LetterDraft>();

function letterOf(tool: string, args: Record<string, unknown>): LetterDraft | null {
  const draft = drafters.get(tool);
  return draft ? draft(args) : null;
}

/** Per tool, the text document its stored arguments would file. */
const previewers = new Map<string, (args: Record<string, unknown>) => TextDocumentPreview>();

function textDocumentOf(tool: string, args: Record<string, unknown>): TextDocumentPreview | null {
  const preview = previewers.get(tool);
  return preview ? preview(args) : null;
}

/** Per tool, the collage its stored arguments describe. */
const collagers = new Map<string, (args: Record<string, unknown>, result: Record<string, unknown> | null) => CollagePreview>();

function collageOf(tool: string, args: Record<string, unknown>, result: Record<string, unknown> | null = null): CollagePreview | null {
  const collage = collagers.get(tool);
  return collage ? collage(args, result) : null;
}

const MAX_CONTINUATION_CHARS = 300;


/** The continuation as stored: trimmed, null for nothing or a placeholder ("nichts", "none"). */
export function cleanContinuation(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length < 4 || /^(?:nichts|keine[rs]?|none|nothing|n\/a|-+)\.?$/i.test(text)) return null;
  return text.length > MAX_CONTINUATION_CHARS ? `${text.slice(0, MAX_CONTINUATION_CHARS - 1).trimEnd()}…` : text;
}

/** Sets what the assistant goes on with once the card ran, for a proposal of this turn that has none yet. */
export async function setContinuation(id: number, continuation: string): Promise<void> {
  await db
    .update(assistantProposal)
    .set({ continuation })
    .where(and(eq(assistantProposal.id, id), sql`${assistantProposal.continuation} IS NULL`));
}

function proposalBlock(row: ProposalRow): ResultBlock {
  return { kind: "proposal", tool: row.tool, rows: [{ ...row }] };
}

/**
 * The catalog entry of a write tool: running it stores a proposal and tells
 * the model so in words it cannot mistake for "done".
 */
export function writeTool(def: WriteToolDefinition): ToolSpec {
  if (def.draft) drafters.set(def.name, def.draft.bind(def));
  if (def.preview) previewers.set(def.name, def.preview.bind(def));
  if (def.collage) collagers.set(def.name, def.collage.bind(def));
  return {
    name: def.name,
    kind: "write",
    summary: def.summary,
    permissions: def.permissions,
    // `after_execute` is not in the schema: the loop lets it through for every
    // write tool and the system prompt names it once.
    parameters: def.parameters,
    source: "hand",
    async run(rawArgs, ctx): Promise<ToolOutcome> {
      const { [AFTER_EXECUTE]: after, ...args } = rawArgs;
      const continuation = cleanContinuation(after);
      const prepared = await def.prepare(args, ctx);
      const twin = await sameProposal(ctx, def.name, prepared.arguments);
      if (twin) throw new Error(twinRefusal(twin));
      const [stored] = await db
        .insert(assistantProposal)
        .values({
          conversation_id: ctx.conversationId ?? null,
          user_id: Number(ctx.user.userID),
          tool: def.name,
          arguments: prepared.arguments,
          summary: prepared.summary,
          continuation,
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
        result_download: null,
        error: null,
        letter: letterOf(def.name, prepared.arguments),
        text_document: textDocumentOf(def.name, prepared.arguments),
        collage: collageOf(def.name, prepared.arguments),
        continuation,
      };
      return {
        text: [
          `Proposal #${stored.id} created, NOT executed: ${prepared.summary}.`,
          ...(prepared.note ? [prepared.note] : []),
          "The user sees a card with \"Ausführen\" and \"Verwerfen\" and decides. Tell them what you proposed; never say it is done.",
          continuation
            ? `Once the user pressed "Ausführen", the app asks you to go on with: ${continuation}. Do not try that step now; say you continue with it as soon as the card is executed.`
            : `A step of the request that needs this card's result waits until it is executed — that is no failure: do not try it now and never say you could not do it; say you go on with it once the card ran.`,
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
 *
 * Asked again for a proposal that ran (the answer to the first click got
 * lost, or a card still showed the state it was stored in), it hands back
 * the proposal as it stands instead of an error: the card then shows it as
 * done. Running it a second time is never what "Ausführen" means.
 */
export async function executeProposal(
  id: number,
  ctx: ToolContext,
  tools: Map<string, WriteToolDefinition>,
  edits?: ProposalEdits,
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
  if (!claimed) {
    const [row] = await db
      .select()
      .from(assistantProposal)
      .where(and(eq(assistantProposal.id, id), eq(assistantProposal.user_id, userId)))
      .limit(1);
    if (row && (row.status === "executed" || row.status === "executing")) return toRow(row);
    throw refusal(row?.status ?? null);
  }

  const def = tools.get(claimed.tool);
  let args = claimed.arguments;
  try {
    if (!def) throw new Error(`Die Aktion ${claimed.tool} gibt es nicht mehr.`);
    if (!def.permissions.every((p) => ctx.user.permissions.includes(p))) {
      throw new Error("Für diese Aktion fehlt dir inzwischen die Berechtigung.");
    }
    if (edits) {
      if (!def.edit) throw new Error("Dieser Vorschlag lässt sich nicht ändern.");
      // Kept even if the action fails below, so the card keeps what was typed.
      args = def.edit(claimed.arguments, edits);
    }
    const result = await def.execute(args, { ...ctx, conversationId: claimed.conversation_id ?? undefined });
    const [done] = await db
      .update(assistantProposal)
      .set({ status: "executed", decided_at: sql`now()`, result: { ...result }, arguments: args })
      .where(eq(assistantProposal.id, id))
      .returning();
    return toRow(done);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const [back] = await db
      .update(assistantProposal)
      .set({ status: "pending", result: { error: message }, arguments: args })
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
  if (!row) {
    const [now] = await db
      .select({ status: assistantProposal.status })
      .from(assistantProposal)
      .where(and(eq(assistantProposal.id, id), eq(assistantProposal.user_id, userId)))
      .limit(1);
    throw refusal(now?.status ?? null);
  }
  return toRow(row);
}

/** The proposal as it stands now, for a card that waits on one being executed. */
export async function readProposal(id: number, userId: number): Promise<ProposalRow> {
  const [row] = await db
    .select()
    .from(assistantProposal)
    .where(and(eq(assistantProposal.id, id), eq(assistantProposal.user_id, userId)))
    .limit(1);
  if (!row) throw refusal(null);
  return toRow(row);
}

const DECIDED: Record<Exclude<ProposalStatus, "pending">, string> = {
  executed: "Dieser Vorschlag ist schon ausgeführt.",
  executing: "Dieser Vorschlag wird gerade ausgeführt.",
  discarded: "Dieser Vorschlag ist schon verworfen.",
};

/** Why a proposal cannot be taken; someone else's reads as missing, not as "decided". */
function refusal(status: ProposalStatus | null): ProposalError {
  if (status === null) return new ProposalError("not_found", "Diesen Vorschlag gibt es nicht.");
  return new ProposalError("decided", status === "pending" ? "Der Vorschlag wartet noch." : DECIDED[status]);
}

export function toRow(row: typeof assistantProposal.$inferSelect): ProposalRow {
  const result = (row.result ?? {}) as { summary?: string; route?: string; download?: string; error?: string };
  return {
    proposal_id: row.id,
    tool: row.tool,
    summary: row.summary,
    count: null,
    status: row.status,
    result_summary: row.status === "executed" ? result.summary ?? null : null,
    result_route: row.status === "executed" ? result.route ?? null : null,
    result_download: row.status === "executed" ? result.download ?? null : null,
    error: row.status === "pending" ? result.error ?? null : null,
    letter: letterOf(row.tool, row.arguments),
    text_document: textDocumentOf(row.tool, row.arguments),
    collage: collageOf(row.tool, row.arguments, row.status === "executed" ? (row.result as Record<string, unknown> | null) : null),
    continuation: row.status === "discarded" ? null : row.continuation ?? null,
  };
}

// ── the state of earlier cards, for later turns ───────────────────────────

const CREATED_RE = /^Proposal #(\d+) created, NOT executed/;
const DIGEST_RE = /^\[earlier proposal #(\d+):/;

/** A proposal as later turns need to know it: what became of it. */
export interface ProposalState {
  status: ProposalStatus;
  summary: string;
  result_summary: string | null;
  route: string | null;
  details: Record<string, unknown> | null;
}

/** The proposals of a conversation, by id, as they stand now. */
export async function proposalStates(conversationId: number): Promise<Map<number, ProposalState>> {
  const rows = await db
    .select({ id: assistantProposal.id, status: assistantProposal.status, summary: assistantProposal.summary, result: assistantProposal.result })
    .from(assistantProposal)
    .where(eq(assistantProposal.conversation_id, conversationId));
  return new Map(rows.map((r) => {
    const result = (r.result ?? {}) as { summary?: unknown; route?: unknown; details?: unknown };
    const executed = r.status === "executed";
    return [r.id, {
      status: r.status,
      summary: r.summary,
      result_summary: executed && typeof result.summary === "string" ? result.summary : null,
      route: executed && typeof result.route === "string" ? result.route : null,
      details: executed && result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : null,
    }];
  }));
}

/**
 * A card of this conversation that does the very same thing: same tool, same
 * prepared arguments, not discarded. After "Ausführen" the app asks the
 * assistant to go on, and the model proposed the card it had just run once
 * more — the user saw the same card again. A discarded card may be proposed
 * again; a pending or executed one is never doubled.
 */
async function sameProposal(ctx: ToolContext, tool: string, args: Record<string, unknown>): Promise<{ id: number; state: ProposalState } | null> {
  if (ctx.conversationId == null) return null;
  const [row] = await db
    .select({ id: assistantProposal.id })
    .from(assistantProposal)
    .where(and(
      eq(assistantProposal.conversation_id, ctx.conversationId),
      eq(assistantProposal.user_id, Number(ctx.user.userID)),
      eq(assistantProposal.tool, tool),
      sql`${assistantProposal.status} <> 'discarded'`,
      sql`${assistantProposal.arguments} = ${JSON.stringify(args)}::jsonb`,
    ))
    .orderBy(sql`${assistantProposal.id} DESC`)
    .limit(1);
  if (!row) return null;
  const state = (await proposalStates(ctx.conversationId)).get(row.id);
  return state ? { id: row.id, state } : null;
}

/** Why the write did not become a second card, and what to do instead. */
export function twinRefusal(twin: { id: number; state: ProposalState }): string {
  const now = twin.state.status === "pending"
    ? `Proposal #${twin.id} (${twin.state.summary}) already does exactly this and still waits for the user's "Ausführen".`
    : proposalStateText(twin.id, twin.state);
  return `no new proposal: ${now} Do not propose it again. Go on with the next step of the request, or, if nothing is left, tell the user what was done.`;
}

/** One line on what became of a card, as the model reads it in a later turn. */
export function proposalStateText(id: number, state: ProposalState): string {
  switch (state.status) {
    case "executed": {
      const details = state.details && Object.keys(state.details).length ? ` (${JSON.stringify(state.details)})` : "";
      return `Proposal #${id} (${state.summary}) was EXECUTED by the user: ${state.result_summary ?? "done"}${details}. It is done — never say it still waits for confirmation or is not confirmed.`;
    }
    case "discarded":
      return `Proposal #${id} (${state.summary}) was DISCARDED by the user; nothing was changed.`;
    case "executing":
      return `Proposal #${id} (${state.summary}) is being executed right now.`;
    default:
      return "";
  }
}

/**
 * A proposal's tool result (or its digest) from an earlier turn, rewritten to
 * what became of the card since: the stored text says "NOT executed" for
 * good, and a later turn that read it kept telling the user the card still
 * waited although it had run. A pending card and any other text stay as they
 * are.
 */
export function currentProposalText(content: string, states: Map<number, ProposalState>): string {
  const match = CREATED_RE.exec(content) ?? DIGEST_RE.exec(content);
  if (!match) return content;
  const id = Number(match[1]);
  const state = states.get(id);
  if (!state || state.status === "pending") return content;
  const text = proposalStateText(id, state);
  return DIGEST_RE.test(content) ? `[${text}]` : text;
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
