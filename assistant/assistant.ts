/**
 * The assistant's endpoints (documentation/plans/ki-assistent.md, stage 2):
 * conversations, asking a question, and watching the answer arrive.
 *
 * A conversation belongs to one user. Asking runs the agent loop as that
 * user (see live.ts for why the question is a POST and the stream only
 * watches). Every tool goes through the services' own endpoints, so the user
 * sees through the assistant exactly what they see in the app.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import log from "encore.dev/log";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import db from "../db/database";
import { assistantConversation, assistantLetter, assistantMessage } from "../db/schema";
import { checkRateLimit } from "../user/rateLimiter";
import { requirePermission } from "../user/auth-handler";
import { AiSlotTimeoutError, withAiSlot } from "../ai-queue/slot-helper";
import { runTurn } from "./agent";
import { cleanContext, describeContext, type ContextRef } from "./briefs";
import { renderLetterPdf } from "./letter-pdf";
import { catalogFor } from "./catalog";
import { chat, ContextTooLargeError, LlmServiceUnavailableError } from "./llm-client";
import { followTurn, openTurn, TURN_ID_RE } from "./live";
import {
  discardProposal,
  executeProposal,
  ProposalError,
  refreshProposalBlocks,
  type ProposalEdits,
  type ProposalRow,
} from "./proposals";
import { WRITE_TOOLS_BY_NAME } from "./tools/writes";
import { fallbackTitle, suggestTitle } from "./titles";
import type { ChatMessage, RefType, ResultBlock, ResultRef, TurnEvent } from "./types";

/** Questions per user and window — each one may cost several model rounds. */
const RATE_LIMIT = { maxAttempts: 20, windowMs: 10 * 60_000 };
const MAX_QUESTION_LENGTH = 4000;
/** Earlier text turns replayed as context (user and assistant messages). */
const HISTORY_MESSAGES = 12;
/** ai-queue priority: someone is waiting for this answer. */
const SLOT_PRIORITY = 1;
/** Naming a conversation can wait behind other work. */
const TITLE_SLOT_PRIORITY = 5;
/** The note of the tools behind one earlier answer, at most. */
const TOOL_NOTE_CHARS = 900;

function currentUser() {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("not signed in");
  return auth;
}

/** Everything but the stream needs the module; see `watchTurn` for why it differs. */
function assistantUser() {
  const auth = currentUser();
  requirePermission(auth, "module.assistant");
  return auth;
}

async function ownConversation(id: number, userId: number) {
  const [row] = await db
    .select()
    .from(assistantConversation)
    .where(and(eq(assistantConversation.id, id), eq(assistantConversation.user_id, userId)))
    .limit(1);
  if (!row) throw APIError.notFound("conversation not found");
  return row;
}

// ── conversations ─────────────────────────────────────────────────────────

export interface ConversationSummary {
  id: number;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  blocks: ResultBlock[];
  created_at: string;
}

/** One object of the working set, as the chip above the chat shows it. */
export interface ContextItem {
  type: "photo" | "document" | "transaction";
  id: number;
  label: string;
  visible: boolean;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ConversationMessage[];
  context: ContextItem[];
}

function summary(row: typeof assistantConversation.$inferSelect): ConversationSummary {
  return { id: row.id, title: row.title, created_at: row.created_at, updated_at: row.updated_at };
}

export interface CreateConversationRequest {
  title?: string;
  /** The working set to start with: a selection, or the document a reply is for (#1534). */
  context?: ContextRef[];
}

export const createConversation = api(
  { expose: true, method: "POST", path: "/assistant/conversations", auth: true },
  async (req: CreateConversationRequest): Promise<ConversationSummary> => {
    const auth = assistantUser();
    const [row] = await db
      .insert(assistantConversation)
      .values({ user_id: Number(auth.userID), title: req.title?.trim().slice(0, 200) || null, context: cleanContext(req.context) })
      .returning();
    return summary(row);
  },
);

export const listConversations = api(
  { expose: true, method: "GET", path: "/assistant/conversations", auth: true },
  async (): Promise<{ conversations: ConversationSummary[] }> => {
    const auth = assistantUser();
    const rows = await db
      .select()
      .from(assistantConversation)
      .where(eq(assistantConversation.user_id, Number(auth.userID)))
      .orderBy(desc(assistantConversation.updated_at), desc(assistantConversation.id))
      .limit(200);
    return { conversations: rows.map(summary) };
  },
);

export const getConversation = api(
  { expose: true, method: "GET", path: "/assistant/conversations/:id", auth: true },
  async ({ id }: { id: number }): Promise<ConversationDetail> => {
    const auth = assistantUser();
    const conversation = await ownConversation(id, Number(auth.userID));
    const rows = await db
      .select()
      .from(assistantMessage)
      .where(eq(assistantMessage.conversation_id, id))
      .orderBy(asc(assistantMessage.id));
    // What the user said and what the assistant answered; the tool rounds in
    // between are the loop's working memory, not part of the chat.
    const messages: ConversationMessage[] = await Promise.all(rows
      .filter((m) => (m.role === "user" || m.role === "assistant") && !m.tool_calls && m.content !== null)
      .map(async (m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content ?? "",
        // Proposal cards show what became of them since, not the state they were stored in.
        blocks: await refreshProposalBlocks((m.blocks ?? []) as ResultBlock[], Number(auth.userID)),
        created_at: m.created_at,
      })));
    const user = { userID: auth.userID, permissions: auth.permissions };
    return { ...summary(conversation), messages, context: await contextItems(conversation.context, user) };
  },
);

async function contextItems(refs: ContextRef[], user: { userID: string; permissions: string[] }): Promise<ContextItem[]> {
  const entries = await describeContext(cleanContext(refs), user);
  return entries.map(({ type, id, label, visible }) => ({ type, id, label, visible }));
}

export interface SetContextRequest {
  id: number;
  context: ContextRef[];
}

/** Replaces the working set; an empty list clears it. */
export const setConversationContext = api(
  { expose: true, method: "PUT", path: "/assistant/conversations/:id/context", auth: true },
  async (req: SetContextRequest): Promise<{ context: ContextItem[] }> => {
    const auth = assistantUser();
    await ownConversation(req.id, Number(auth.userID));
    const context = cleanContext(req.context);
    await db.update(assistantConversation).set({ context }).where(eq(assistantConversation.id, req.id));
    return { context: await contextItems(context, { userID: auth.userID, permissions: auth.permissions }) };
  },
);

export const deleteConversation = api(
  { expose: true, method: "DELETE", path: "/assistant/conversations/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ deleted: boolean }> => {
    const auth = assistantUser();
    await ownConversation(id, Number(auth.userID));
    await db.delete(assistantConversation).where(eq(assistantConversation.id, id));
    return { deleted: true };
  },
);

// ── asking ────────────────────────────────────────────────────────────────

export interface AskRequest {
  id: number;
  message: string;
  /**
   * Chosen by the client before posting, so it can open
   * `/assistant/turns/:turnId/stream` first and see the answer arrive.
   */
  turnId?: string;
}

export interface AskResponse {
  answer: string;
  blocks: ResultBlock[];
  message_id: number;
  rounds: number;
}

/**
 * Earlier turns as the model sees them again: each question with its answer,
 * and after the answer a note of the tools behind it — name, arguments and
 * the one-line digest of what they found — so a follow-up ("nur die aus
 * München") knows what the previous answer was based on without the rows.
 */
export async function history(conversationId: number): Promise<ChatMessage[]> {
  const rows = (await db
    .select({
      role: assistantMessage.role,
      content: assistantMessage.content,
      tool_calls: assistantMessage.tool_calls,
      tool_call_id: assistantMessage.tool_call_id,
      digest: assistantMessage.digest,
    })
    .from(assistantMessage)
    .where(eq(assistantMessage.conversation_id, conversationId))
    .orderBy(desc(assistantMessage.id))
    .limit(HISTORY_MESSAGES * 6)).reverse();

  const turns: ChatMessage[] = [];
  let calls: Array<{ id: string; name: string; arguments: string }> = [];
  const digests = new Map<string, string>();
  for (const m of rows) {
    if (m.role === "user") {
      calls = [];
      if (m.content) turns.push({ role: "user", content: m.content });
    } else if (m.role === "tool") {
      if (m.tool_call_id && m.digest) digests.set(m.tool_call_id, m.digest);
    } else if (m.tool_calls) {
      calls.push(...m.tool_calls);
    } else if (m.content) {
      turns.push({ role: "assistant", content: m.content + toolNote(calls, digests) });
      calls = [];
    }
  }
  const recent = turns.slice(-HISTORY_MESSAGES);
  // Start on a question, so the replayed history never opens with an answer.
  const first = recent.findIndex((m) => m.role === "user");
  return recent.slice(first < 0 ? recent.length : first);
}

function toolNote(calls: Array<{ id: string; name: string; arguments: string }>, digests: Map<string, string>): string {
  if (!calls.length) return "";
  const lines = calls.map((c) => {
    const args = c.arguments && c.arguments !== "{}" ? ` ${c.arguments.slice(0, 200)}` : "";
    return `${c.name}${args} → ${digests.get(c.id) ?? "[no result]"}`;
  });
  let note = `\n\n[tools behind this answer: ${lines.join("; ")}]`;
  if (note.length > TOOL_NOTE_CHARS) note = `${note.slice(0, TOOL_NOTE_CHARS - 2)}…]`;
  return note;
}

/** The latest result set of each type in the conversation, for `from_previous_result`. */
async function previousRefs(conversationId: number): Promise<Partial<Record<RefType, number[]>>> {
  const rows = await db
    .select({ ref: assistantMessage.result_ref })
    .from(assistantMessage)
    .where(and(eq(assistantMessage.conversation_id, conversationId), sql`${assistantMessage.result_ref} IS NOT NULL`))
    .orderBy(desc(assistantMessage.id))
    .limit(50);
  const refs: Partial<Record<RefType, number[]>> = {};
  for (const { ref } of rows) {
    if (ref && !refs[ref.type]) refs[ref.type] = ref.ids;
  }
  return refs;
}

async function persist(
  conversationId: number,
  transcript: ChatMessage[],
  blocks: ResultBlock[],
  toolResults: Record<string, { digest: string; ref?: ResultRef }> = {},
): Promise<number> {
  let finalId = 0;
  for (let i = 0; i < transcript.length; i++) {
    const m = transcript[i];
    const isFinal = i === transcript.length - 1;
    const [row] = await db
      .insert(assistantMessage)
      .values({
        conversation_id: conversationId,
        role: m.role === "system" ? "assistant" : m.role,
        content: m.content ?? null,
        tool_calls: m.role === "assistant" && m.tool_calls
          ? m.tool_calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }))
          : null,
        tool_call_id: m.role === "tool" ? m.tool_call_id : null,
        digest: m.role === "tool" ? toolResults[m.tool_call_id]?.digest ?? null : null,
        result_ref: m.role === "tool" ? toolResults[m.tool_call_id]?.ref ?? null : null,
        blocks: isFinal && blocks.length ? blocks : null,
      })
      .returning({ id: assistantMessage.id });
    if (isFinal) finalId = row.id;
  }
  return finalId;
}

export const ask = api(
  { expose: true, method: "POST", path: "/assistant/conversations/:id/ask", auth: true },
  async (req: AskRequest): Promise<AskResponse> => {
    const auth = assistantUser();
    const userId = Number(auth.userID);
    const question = req.message?.trim() ?? "";
    if (!question) throw APIError.invalidArgument("message is empty");
    if (question.length > MAX_QUESTION_LENGTH) {
      throw APIError.invalidArgument(`message is longer than ${MAX_QUESTION_LENGTH} characters`);
    }
    if (req.turnId !== undefined && !TURN_ID_RE.test(req.turnId)) {
      throw APIError.invalidArgument("turnId must be 8 to 64 letters, digits, '-' or '_'");
    }
    const conversation = await ownConversation(req.id, userId);
    checkRateLimit(`assistant:${auth.userID}`, { ...RATE_LIMIT, message: "Too many questions to the assistant." });

    let emit: (event: TurnEvent) => void = () => {};
    if (req.turnId) {
      try {
        emit = openTurn(req.turnId, auth.userID);
      } catch (err) {
        throw APIError.alreadyExists((err as Error).message);
      }
    }

    const user = { userID: auth.userID, permissions: auth.permissions };
    try {
      const refs = cleanContext(conversation.context);
      const entries = refs.length ? await describeContext(refs, user) : [];
      const result = await runTurn({
        user,
        history: await history(conversation.id),
        question,
        conversationId: conversation.id,
        previousRefs: await previousRefs(conversation.id),
        context: entries.length
          ? { refs: entries.filter((e) => e.visible).map(({ type, id }) => ({ type, id })), briefs: entries.map((e) => e.brief) }
          : undefined,
        tools: catalogFor(user),
        chat,
        emit,
        withSlot: (fn) => withAiSlot("llm", SLOT_PRIORITY, "assistant", fn),
        log: (entry) => log.info("assistant tool call", {
          conversation_id: conversation.id,
          tool: entry.tool,
          argument_keys: Object.keys(entry.arguments).join(","),
          arguments: JSON.stringify(entry.arguments).slice(0, 300),
          rows: entry.rows,
          ms: entry.ms,
          error: entry.error,
        }),
      });

      const messageId = await persist(conversation.id, result.transcript, result.blocks, result.toolResults);
      const fallback = fallbackTitle(question);
      await db
        .update(assistantConversation)
        .set({ updated_at: sql`now()`, title: conversation.title ?? fallback })
        .where(eq(assistantConversation.id, conversation.id));
      if (conversation.title === null) nameConversation(conversation.id, question, fallback);
      log.info("assistant answered", { conversation_id: conversation.id, rounds: result.rounds, blocks: result.blocks.length });
      return { answer: result.answer, blocks: result.blocks, message_id: messageId, rounds: result.rounds };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message });
      if (err instanceof LlmServiceUnavailableError || err instanceof AiSlotTimeoutError) {
        throw APIError.unavailable("the assistant's model is busy or reloading — try again in a moment");
      }
      if (err instanceof ContextTooLargeError) {
        throw APIError.failedPrecondition("this conversation no longer fits the model's context — start a new one");
      }
      log.error(err, "assistant turn failed", { conversation_id: conversation.id });
      if (err instanceof APIError) throw err;
      throw APIError.internal("the assistant could not answer");
    }
  },
);

// ── titles ────────────────────────────────────────────────────────────────

const naming = new Set<Promise<void>>();

/**
 * Names a new conversation after its first answer, in the background. Only
 * replaces the fallback, so a title set meanwhile stays.
 */
function nameConversation(id: number, question: string, fallback: string): void {
  const job = withAiSlot("llm", TITLE_SLOT_PRIORITY, "assistant-title", () => suggestTitle(chat, question))
    .then(async (title) => {
      if (!title || title === fallback) return;
      await db
        .update(assistantConversation)
        .set({ title })
        .where(and(eq(assistantConversation.id, id), eq(assistantConversation.title, fallback)));
    })
    .catch((err) => log.warn("assistant conversation title failed", { conversation_id: id, error: String(err) }))
    .finally(() => naming.delete(job));
  naming.add(job);
}

/** Waits for titles still being made; for tests. */
export async function __settleTitlesForTests(): Promise<void> {
  await Promise.all([...naming]);
}

// ── proposals ─────────────────────────────────────────────────────────────

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function proposalError(err: unknown): never {
  if (err instanceof ProposalError) {
    if (err.reason === "not_found") throw APIError.notFound(err.message);
    throw APIError.failedPrecondition(err.message);
  }
  throw err;
}

/**
 * Runs a proposal the assistant made, as the user, through the services' own
 * endpoints. A failure comes back as the proposal with `error` set and stays
 * pending, so the card can say what went wrong and offer to try again.
 */
export interface ExecuteProposalRequest {
  id: number;
  /** What the user changed on the card; only proposals that offer editing take it. */
  edits?: ProposalEdits;
}

export const executeAssistantProposal = api(
  { expose: true, method: "POST", path: "/assistant/proposals/:id/execute", auth: true },
  async ({ id, edits }: ExecuteProposalRequest): Promise<ProposalRow> => {
    const auth = assistantUser();
    const ctx = { user: { userID: auth.userID, permissions: auth.permissions }, today: today() };
    const row = await executeProposal(id, ctx, WRITE_TOOLS_BY_NAME, edits).catch(proposalError);
    log.info("assistant proposal decided", { proposal_id: id, tool: row.tool, status: row.status, failed: row.error !== null });
    return row;
  },
);

export const discardAssistantProposal = api(
  { expose: true, method: "POST", path: "/assistant/proposals/:id/discard", auth: true },
  async ({ id }: { id: number }): Promise<ProposalRow> => {
    const auth = assistantUser();
    const ctx = { user: { userID: auth.userID, permissions: auth.permissions }, today: today() };
    return discardProposal(id, ctx).catch(proposalError);
  },
);

// ── letters ───────────────────────────────────────────────────────────────

function pdfName(subject: string, date: string): string {
  const slug = subject.normalize("NFKD").replace(/[^\w -]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60);
  return `Brief-${date}${slug ? `-${slug}` : ""}.pdf`;
}

/**
 * A confirmed letter as PDF, rendered from its stored fields. Only its
 * author may fetch it; anyone else gets a 404.
 */
export const letterPdf = api.raw(
  { expose: true, method: "GET", path: "/assistant/letters/:id/pdf", auth: true },
  async (req, res) => {
    try {
      const auth = assistantUser();
      const id = Number((req.url ?? "").split("?")[0].split("/").at(-2));
      if (!Number.isInteger(id)) throw APIError.invalidArgument("bad letter id");
      const [letter] = await db
        .select()
        .from(assistantLetter)
        .where(and(eq(assistantLetter.id, id), eq(assistantLetter.user_id, Number(auth.userID))))
        .limit(1);
      if (!letter) throw APIError.notFound("letter not found");
      const pdf = await renderLetterPdf({
        sender: letter.sender,
        recipient: letter.recipient,
        subject: letter.subject,
        body: letter.body,
        date: letter.letter_date,
        attachments: letter.attachments.map((a) => a.title),
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", `attachment; filename="${pdfName(letter.subject, letter.letter_date)}"`);
      res.end(pdf);
    } catch (err) {
      const status = err instanceof APIError
        ? ({ not_found: 404, unauthenticated: 401, permission_denied: 403, invalid_argument: 400 } as Record<string, number>)[err.code] ?? 500
        : 500;
      res.statusCode = status;
      res.end(err instanceof Error ? err.message : "error");
    }
  },
);

// ── watching ──────────────────────────────────────────────────────────────

/**
 * One event of a running turn. Flat rather than a union so the stream's
 * schema stays simple for every client: `type` says which fields are set.
 *
 * `token`s belong to the round they arrive in: a model may write a sentence
 * before it calls tools, so a client starts the answer text afresh after a
 * `tool_start`. `done` carries the final answer either way.
 */
export interface StreamEvent {
  type: "token" | "retract" | "tool_start" | "tool_result" | "done" | "error";
  text?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  row_count?: number;
  block?: ResultBlock;
  error?: string;
  answer?: string;
  blocks?: ResultBlock[];
  message?: string;
}

export function toStreamEvent(event: TurnEvent): StreamEvent {
  switch (event.type) {
    case "token":
      return { type: "token", text: event.text };
    case "retract":
      return { type: "retract" };
    case "tool_start":
      return { type: "tool_start", tool: event.tool, arguments: event.arguments };
    case "tool_result":
      return { type: "tool_result", tool: event.tool, row_count: event.rowCount, block: event.block, error: event.error };
    case "done":
      return { type: "done", answer: event.answer, blocks: event.blocks };
    case "error":
      return { type: "error", message: event.message };
  }
}

interface WatchHandshake {
  turnId: string;
}

export const watchTurn = api.streamOut<WatchHandshake, StreamEvent>(
  { expose: true, path: "/assistant/turns/:turnId/stream", auth: true },
  async ({ turnId }, stream) => {
    // No module check here: a browser opens this socket with `?token=`, which
    // carries only the media scope, so requirePermission would refuse every
    // caller. Nothing is lost — a turn can only be posted through `ask`, which
    // checks the module, and only its owner may follow it (live.ts).
    const auth = currentUser();
    if (!TURN_ID_RE.test(turnId)) {
      try { stream.send({ type: "error", message: "invalid turn id" }); } catch { /* closed */ }
      await stream.close();
      return;
    }
    // stream.send() is synchronous and throws once the socket is gone
    // (realtime/subscribe.ts); a dead socket just stops the forwarding.
    let open = true;
    try {
      await followTurn(turnId, auth.userID, (event) => {
        if (!open) return;
        try {
          stream.send(toStreamEvent(event));
        } catch {
          open = false;
        }
      });
    } catch (err) {
      if (open) {
        try { stream.send({ type: "error", message: (err as Error).message }); } catch { /* closed */ }
      }
    }
    try { await stream.close(); } catch { /* already closed */ }
  },
);
