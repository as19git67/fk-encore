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
import { assistantConversation, assistantMessage } from "../db/schema";
import { checkRateLimit } from "../user/rateLimiter";
import { AiSlotTimeoutError, withAiSlot } from "../ai-queue/slot-helper";
import { runTurn } from "./agent";
import { catalogFor } from "./catalog";
import { chat, ContextTooLargeError, LlmServiceUnavailableError } from "./llm-client";
import { followTurn, openTurn, TURN_ID_RE } from "./live";
import type { ChatMessage, ResultBlock, TurnEvent } from "./types";

/** Questions per user and window — each one may cost several model rounds. */
const RATE_LIMIT = { maxAttempts: 20, windowMs: 10 * 60_000 };
const MAX_QUESTION_LENGTH = 4000;
/** Earlier text turns replayed as context (user and assistant messages). */
const HISTORY_MESSAGES = 12;
/** ai-queue priority: someone is waiting for this answer. */
const SLOT_PRIORITY = 1;

function currentUser() {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("not signed in");
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

export interface ConversationDetail extends ConversationSummary {
  messages: ConversationMessage[];
}

function summary(row: typeof assistantConversation.$inferSelect): ConversationSummary {
  return { id: row.id, title: row.title, created_at: row.created_at, updated_at: row.updated_at };
}

export interface CreateConversationRequest {
  title?: string;
}

export const createConversation = api(
  { expose: true, method: "POST", path: "/assistant/conversations", auth: true },
  async (req: CreateConversationRequest): Promise<ConversationSummary> => {
    const auth = currentUser();
    const [row] = await db
      .insert(assistantConversation)
      .values({ user_id: Number(auth.userID), title: req.title?.trim().slice(0, 200) || null })
      .returning();
    return summary(row);
  },
);

export const listConversations = api(
  { expose: true, method: "GET", path: "/assistant/conversations", auth: true },
  async (): Promise<{ conversations: ConversationSummary[] }> => {
    const auth = currentUser();
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
    const auth = currentUser();
    const conversation = await ownConversation(id, Number(auth.userID));
    const rows = await db
      .select()
      .from(assistantMessage)
      .where(eq(assistantMessage.conversation_id, id))
      .orderBy(asc(assistantMessage.id));
    // What the user said and what the assistant answered; the tool rounds in
    // between are the loop's working memory, not part of the chat.
    const messages: ConversationMessage[] = rows
      .filter((m) => (m.role === "user" || m.role === "assistant") && !m.tool_calls && m.content !== null)
      .map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content ?? "",
        blocks: (m.blocks ?? []) as ResultBlock[],
        created_at: m.created_at,
      }));
    return { ...summary(conversation), messages };
  },
);

export const deleteConversation = api(
  { expose: true, method: "DELETE", path: "/assistant/conversations/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ deleted: boolean }> => {
    const auth = currentUser();
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

async function history(conversationId: number): Promise<ChatMessage[]> {
  const rows = await db
    .select({ role: assistantMessage.role, content: assistantMessage.content, tool_calls: assistantMessage.tool_calls })
    .from(assistantMessage)
    .where(eq(assistantMessage.conversation_id, conversationId))
    .orderBy(desc(assistantMessage.id))
    .limit(HISTORY_MESSAGES * 4);
  const turns = rows
    .filter((m) => (m.role === "user" || m.role === "assistant") && !m.tool_calls && m.content)
    .slice(0, HISTORY_MESSAGES)
    .reverse();
  // Start on a question, so the replayed history never opens with an answer.
  const first = turns.findIndex((m) => m.role === "user");
  return turns.slice(first < 0 ? turns.length : first).map((m) =>
    m.role === "user"
      ? { role: "user", content: m.content! }
      : { role: "assistant", content: m.content! },
  );
}

async function persist(conversationId: number, transcript: ChatMessage[], blocks: ResultBlock[]): Promise<number> {
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
    const auth = currentUser();
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
      const result = await runTurn({
        user,
        history: await history(conversation.id),
        question,
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

      const messageId = await persist(conversation.id, result.transcript, result.blocks);
      await db
        .update(assistantConversation)
        .set({
          updated_at: sql`now()`,
          title: conversation.title ?? question.replace(/\s+/g, " ").slice(0, 80),
        })
        .where(eq(assistantConversation.id, conversation.id));
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
  type: "token" | "tool_start" | "tool_result" | "done" | "error";
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
