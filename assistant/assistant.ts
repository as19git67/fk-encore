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
import { AI_PRIORITY, AiSlotTimeoutError, withAiPriority, withAiSlot } from "../ai-queue/slot-helper";
import { runTurn } from "./agent";
import { cleanContext, describeContext, type ContextRef } from "./briefs";
import { renderLetterPdf } from "./letter-pdf";
import { catalogFor } from "./catalog";
import { chat, ContextTooLargeError, knownContextWindow, LlmServiceUnavailableError } from "./llm-client";
import { cancelTurn, followTurn, openTurn, TURN_ID_RE, turnSignal } from "./live";
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
import { summarizedTurn, summarizeTurn, summaryNote } from "./summary";
import { verifyByDefault } from "./verify";
import type { ChatMessage, ContextUsage, RefType, ResultBlock, ResultRef, TurnEvent } from "./types";

/** Questions per user and window — each one may cost several model rounds. */
const RATE_LIMIT = { maxAttempts: 20, windowMs: 10 * 60_000 };
const MAX_QUESTION_LENGTH = 4000;
/**
 * Earlier turns (question, tool calls, answer) offered as context. A ceiling,
 * not the rule: the agent loop drops the oldest turns first until the rest
 * fits the model's window, so as much of the conversation stays as fits.
 */
const HISTORY_TURNS = 50;
/**
 * The newest earlier turns go along as they happened — question, tool calls
 * with their results, answer — so a follow-up can still read the rows. Older
 * turns go as question and the model's summary of the turn (stage 4 of
 * assistent-wegfindung.md), once that is written; until then, or when the
 * turn called no tool, they go whole as well.
 */
export const WHOLE_TURNS = 3;
/**
 * ai-queue priority: someone is waiting for this answer, so it goes before
 * every other model job, a running batch classification included. The whole
 * turn runs in this lane, so a tool that asks the model is not queued as
 * background either.
 */
const SLOT_PRIORITY = AI_PRIORITY.assistant;
/** Naming a conversation can wait behind other work. */
const TITLE_SLOT_PRIORITY = AI_PRIORITY.idle;
/** The summary of a turn should be there before the next question, so it goes before batch work but after anyone waiting. */
const SUMMARY_SLOT_PRIORITY = AI_PRIORITY.background;

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
  /** Answers only: how full the model's window got in that turn. */
  context_usage?: ContextUsage | null;
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
        context_usage: (m.context_usage as ContextUsage | null) ?? null,
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
  context_usage: ContextUsage;
}

/**
 * Earlier turns as the model sees them again: each question, the tool calls
 * behind its answer with what each found, and the answer. Replayed as real
 * tool calls rather than a note in the answer — a model that saw "[tools
 * behind this answer: …]" in earlier answers wrote such notes itself instead
 * of calling the tool. The newest `WHOLE_TURNS` go along whole, so a
 * follow-up can still read the rows an earlier answer was based on; an older
 * turn with a summary goes as its question and that summary (stage 4 of
 * assistent-wegfindung.md). `digests` holds the one-line form each whole
 * result shrinks to when the window runs short, the oldest first;
 * `summarized` says how many turns went as summaries.
 */
export async function history(conversationId: number): Promise<{ messages: ChatMessage[]; digests: Record<string, string>; summarized: number }> {
  const rows = (await db
    .select({
      role: assistantMessage.role,
      content: assistantMessage.content,
      tool_calls: assistantMessage.tool_calls,
      tool_call_id: assistantMessage.tool_call_id,
      digest: assistantMessage.digest,
      summary: assistantMessage.summary,
    })
    .from(assistantMessage)
    .where(eq(assistantMessage.conversation_id, conversationId))
    .orderBy(desc(assistantMessage.id))
    .limit(HISTORY_TURNS * 12)).reverse();

  interface Turn {
    messages: ChatMessage[];
    /** The model's summary on the answer row, when written. */
    summary: string | null;
    /** The tools of the turn with their digests, for the summary's note. */
    tools: Array<{ tool: string; digest: string | null }>;
  }
  const turns: Turn[] = [];
  const digests: Record<string, string> = {};
  let turn: Turn | null = null;
  let open = new Map<string, string>();
  // Every call gets its result before the next message, even one whose row is missing.
  const closeCalls = () => {
    for (const id of open.keys()) turn?.messages.push({ role: "tool", tool_call_id: id, content: "[no result kept]" });
    open = new Map();
  };
  for (const m of rows) {
    if (m.role === "user") {
      closeCalls();
      turn = m.content ? { messages: [{ role: "user", content: m.content }], summary: null, tools: [] } : null;
      if (turn) turns.push(turn);
    } else if (!turn) {
      continue; // the fetched window began inside a turn
    } else if (m.role === "tool") {
      if (!m.tool_call_id || !open.has(m.tool_call_id)) continue;
      const name = open.get(m.tool_call_id)!;
      open.delete(m.tool_call_id);
      turn.messages.push({ role: "tool", tool_call_id: m.tool_call_id, content: m.content ?? m.digest ?? "[no result kept]" });
      if (m.digest) digests[m.tool_call_id] = m.digest;
      turn.tools.push({ tool: name, digest: m.digest ?? null });
    } else if (m.tool_calls) {
      closeCalls();
      turn.messages.push({
        role: "assistant",
        content: null,
        tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })),
      });
      for (const c of m.tool_calls) open.set(c.id, c.name);
    } else if (m.content) {
      closeCalls();
      turn.messages.push({ role: "assistant", content: m.content });
      turn.summary = m.summary ?? null;
    }
  }
  closeCalls();
  // Only turns that ended in an answer; a failed turn has nothing to build on.
  const complete = turns.filter((t) => {
    const last = t.messages.at(-1)!;
    return last.role === "assistant" && !("tool_calls" in last && last.tool_calls);
  }).slice(-HISTORY_TURNS);
  let summarized = 0;
  const messages = complete.flatMap((t, i) => {
    const old = i < complete.length - WHOLE_TURNS;
    if (!old || !t.summary) return t.messages;
    summarized++;
    const question = (t.messages[0] as { content: string }).content;
    // The digests of a summarized turn are not in the request; nothing to shrink.
    for (const m of t.messages) if (m.role === "tool") delete digests[m.tool_call_id];
    return summarizedTurn(question, t.summary, summaryNote(t.tools));
  });
  return { messages, digests, summarized };
}

/** Questions asked in the conversation so far, answered or not. */
async function questionCount(conversationId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(assistantMessage)
    .where(and(eq(assistantMessage.conversation_id, conversationId), eq(assistantMessage.role, "user")));
  return row?.n ?? 0;
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
  contextUsage: ContextUsage | null = null,
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
        context_usage: isFinal && contextUsage ? { ...contextUsage } : null,
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
    let signal: AbortSignal | undefined;
    if (req.turnId) {
      try {
        signal = turnSignal(req.turnId, auth.userID);
        emit = openTurn(req.turnId, auth.userID);
      } catch (err) {
        throw APIError.alreadyExists((err as Error).message);
      }
    }

    const user = { userID: auth.userID, permissions: auth.permissions };
    try {
      const earlierTurns = await questionCount(conversation.id);
      const earlier = await history(conversation.id);
      const refs = cleanContext(conversation.context);
      const entries = refs.length ? await describeContext(refs, user) : [];
      const result = await withAiPriority(SLOT_PRIORITY, async () => runTurn({
        user,
        history: earlier.messages,
        historyDigests: earlier.digests,
        contextWindow: knownContextWindow() ?? undefined,
        question,
        conversationId: conversation.id,
        previousRefs: await previousRefs(conversation.id),
        context: entries.length
          ? { refs: entries.filter((e) => e.visible).map(({ type, id }) => ({ type, id })), briefs: entries.map((e) => e.brief) }
          : undefined,
        tools: catalogFor(user),
        chat,
        emit,
        signal,
        routeModel: true,
        verify: verifyByDefault(),
        withSlot: (fn) => withAiSlot("llm", SLOT_PRIORITY, "assistant", fn, undefined, signal),
        log: (entry) => log.info("assistant tool call", {
          conversation_id: conversation.id,
          tool: entry.tool,
          argument_keys: Object.keys(entry.arguments).join(","),
          arguments: JSON.stringify(entry.arguments).slice(0, 300),
          rows: entry.rows,
          ms: entry.ms,
          error: entry.error,
        }),
      }));

      const contextUsage: ContextUsage = { ...result.context, earlierTurns, summarizedTurns: earlier.summarized };
      const messageId = await persist(conversation.id, result.transcript, result.blocks, result.toolResults, contextUsage);
      summarizeLater(conversation.id, messageId, result.transcript);
      const fallback = fallbackTitle(question);
      await db
        .update(assistantConversation)
        .set({ updated_at: sql`now()`, title: conversation.title ?? fallback })
        .where(eq(assistantConversation.id, conversation.id));
      if (conversation.title === null) nameConversation(conversation.id, question, fallback);
      log.info("assistant answered", {
        conversation_id: conversation.id,
        rounds: result.rounds,
        blocks: result.blocks.length,
        context_used: contextUsage.used,
        context_window: contextUsage.window,
        context_estimated: contextUsage.estimated,
        kept_turns: contextUsage.keptTurns,
        earlier_turns: earlierTurns,
      });
      return { answer: result.answer, blocks: result.blocks, message_id: messageId, rounds: result.rounds, context_usage: contextUsage };
    } catch (err) {
      if (signal?.aborted) {
        // Nothing of a stopped turn is kept, like a failed one: the next
        // question starts from the last answer.
        emit({ type: "cancelled" });
        log.info("assistant turn cancelled", { conversation_id: conversation.id });
        throw APIError.canceled("the answer was cancelled");
      }
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

interface CancelTurnRequest {
  turnId: string;
}

interface CancelTurnResponse {
  /** False when the turn had already finished (or was never known here). */
  cancelled: boolean;
}

/**
 * The "Abbrechen" under a running answer. The turn stops where it is: a wait
 * in the ai-queue is left, a model call is closed (the llm-service then stops
 * llama-server, so the slot is free for the next caller), and a tool that is
 * running finishes but no further one starts. `ask` then answers `canceled`.
 */
export const cancelAssistantTurn = api(
  { expose: true, method: "POST", path: "/assistant/turns/:turnId/cancel", auth: true },
  async ({ turnId }: CancelTurnRequest): Promise<CancelTurnResponse> => {
    const auth = assistantUser();
    if (!TURN_ID_RE.test(turnId)) throw APIError.invalidArgument("invalid turn id");
    return { cancelled: cancelTurn(turnId, auth.userID) };
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

const summarizing = new Set<Promise<void>>();

/**
 * The summary of the turn just answered (stage 4 of assistent-wegfindung.md),
 * written onto its answer row after the answer has gone out. Only a turn
 * that called a tool gets one: an answer without tools is already its own
 * summary. A failure leaves the row as it is; the turn then replays whole.
 */
function summarizeLater(conversationId: number, messageId: number, transcript: ChatMessage[]): void {
  if (!transcript.some((m) => m.role === "assistant" && m.tool_calls?.length)) return;
  const job = withAiSlot("llm", SUMMARY_SLOT_PRIORITY, "assistant-summary", () => summarizeTurn(chat, transcript))
    .then(async (summary) => {
      if (!summary) return;
      await db
        .update(assistantMessage)
        .set({ summary })
        .where(and(eq(assistantMessage.id, messageId), eq(assistantMessage.conversation_id, conversationId)));
    })
    .catch((err) => log.warn("assistant turn summary failed", { conversation_id: conversationId, error: String(err) }))
    .finally(() => summarizing.delete(job));
  summarizing.add(job);
}

/** Waits for summaries still being written; for tests. */
export async function __settleSummariesForTests(): Promise<void> {
  await Promise.all([...summarizing]);
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
  type: "token" | "retract" | "tool_start" | "tool_result" | "done" | "error" | "cancelled";
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
    case "cancelled":
      return { type: "cancelled" };
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
