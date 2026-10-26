/**
 * Feedback under an answer (documentation/plans/assistent-wegfindung.md,
 * stage 6): the failures the benchmark lacks come from the users.
 *
 *   POST   /assistant/messages/:id/feedback   thumbs up or down, by the conversation's owner
 *   GET    /assistant/feedback                 newest first, with a case draft each (data.manage)
 *   DELETE /assistant/feedback/:id             (data.manage)
 *
 * An entry copies the question, the tool trace of that turn and the answer,
 * so it survives the conversation and says which road the model took. The
 * trace holds tool names, arguments, row counts and errors — never the rows
 * a tool returned. The case draft is a `BenchCase` skeleton to paste into
 * `bench/cases.ts` after every real value is replaced by a made-up one.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, desc, eq, lte } from "drizzle-orm";
import db from "../db/database";
import { assistantConversation, assistantFeedback, assistantMessage } from "../db/schema";
import { requirePermission } from "../user/auth-handler";

export type FeedbackVerdict = "up" | "down";

export interface TraceEntry {
  tool: string;
  arguments: Record<string, unknown>;
  /** Rows the tool returned, as its digest counted them; null when unknown. */
  rows: number | null;
  error: string | null;
}

const MAX_COMMENT_LENGTH = 2000;
/** A long argument (a letter body) is cut: the trace is about the road, not the text. */
const MAX_ARGUMENT_LENGTH = 300;

function currentUser() {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("not signed in");
  return auth;
}

function shorten(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_ARGUMENT_LENGTH ? `${value.slice(0, MAX_ARGUMENT_LENGTH)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(shorten);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shorten(v)]));
  }
  return value;
}

/** `[earlier result of list_photos: 12 rows, ids …]` → 12. */
export function rowsOfDigest(digest: string | null): number | null {
  const m = digest?.match(/(\d+) rows?\b/);
  return m ? Number(m[1]) : null;
}

type MessageRow = typeof assistantMessage.$inferSelect;

/**
 * The turn behind an answer: from the user's question before it up to the
 * answer, as the loop stored it. Returns the question and the trace.
 */
export function turnOf(rows: MessageRow[], answerId: number): { question: string; trace: TraceEntry[] } | null {
  const upTo = rows.filter((m) => m.id <= answerId).sort((a, b) => a.id - b.id);
  const answer = upTo[upTo.length - 1];
  if (!answer || answer.id !== answerId || answer.role !== "assistant" || answer.tool_calls || answer.content === null) return null;
  let start = upTo.length - 1;
  while (start > 0 && upTo[start].role !== "user") start--;
  if (upTo[start].role !== "user") return null;
  const turn = upTo.slice(start);
  const results = new Map<string, MessageRow>();
  for (const m of turn) if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, m);
  const trace: TraceEntry[] = [];
  for (const m of turn) {
    for (const call of m.tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.arguments);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
      } catch {
        // kept empty: the model's arguments were not JSON
      }
      const result = results.get(call.id);
      const content = result?.content ?? "";
      const error = content.startsWith("error:") ? content.slice(0, 300) : null;
      trace.push({ tool: call.name, arguments: shorten(args) as Record<string, unknown>, rows: error ? null : rowsOfDigest(result?.digest ?? null), error });
    }
  }
  return { question: turn[0].content ?? "", trace };
}

export interface FeedbackRequest {
  id: number;
  verdict: FeedbackVerdict;
  comment?: string;
}

export interface FeedbackEntry {
  id: number;
  verdict: FeedbackVerdict;
  comment: string | null;
  question: string;
  trace: TraceEntry[];
  answer: string;
  conversation_id: number | null;
  message_id: number | null;
  created_at: string;
  /** A `BenchCase` skeleton as JSON, to paste into `bench/cases.ts` after anonymising. */
  case_draft: string;
}

/**
 * The case the entry suggests: the trace as expected calls, no canned
 * results yet. Real values stay in — whoever pastes it replaces them, which
 * the title reminds of.
 */
export function caseDraft(entry: { id: number; question: string; trace: TraceEntry[] }): string {
  const draft = {
    id: `feedback-${entry.id}`,
    title: "TODO: what the case checks — replace every real name, number and amount",
    question: entry.question,
    expect: entry.trace.filter((t) => !t.error).map((t) => ({ tool: t.tool, args: t.arguments })),
    results: Object.fromEntries(entry.trace.map((t) => [t.tool, { rows: [] }])),
  };
  return JSON.stringify(draft, null, 2);
}

type FeedbackRow = typeof assistantFeedback.$inferSelect;

function toEntry(row: FeedbackRow): FeedbackEntry {
  return {
    id: row.id,
    verdict: row.verdict,
    comment: row.comment,
    question: row.question,
    trace: row.trace,
    answer: row.answer,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    created_at: row.created_at,
    case_draft: caseDraft({ id: row.id, question: row.question, trace: row.trace }),
  };
}

export const giveFeedback = api(
  { expose: true, method: "POST", path: "/assistant/messages/:id/feedback", auth: true },
  async (req: FeedbackRequest): Promise<{ id: number; verdict: FeedbackVerdict }> => {
    const auth = currentUser();
    requirePermission(auth, "module.assistant");
    if (req.verdict !== "up" && req.verdict !== "down") throw APIError.invalidArgument("verdict must be up or down");
    const comment = req.comment?.trim() ?? "";
    if (comment.length > MAX_COMMENT_LENGTH) throw APIError.invalidArgument(`comment is longer than ${MAX_COMMENT_LENGTH} characters`);

    const [message] = await db.select().from(assistantMessage).where(eq(assistantMessage.id, req.id)).limit(1);
    if (!message) throw APIError.notFound("message not found");
    const [conversation] = await db
      .select({ id: assistantConversation.id })
      .from(assistantConversation)
      .where(and(eq(assistantConversation.id, message.conversation_id), eq(assistantConversation.user_id, Number(auth.userID))))
      .limit(1);
    if (!conversation) throw APIError.notFound("message not found");

    const rows = await db
      .select()
      .from(assistantMessage)
      .where(and(eq(assistantMessage.conversation_id, conversation.id), lte(assistantMessage.id, req.id)))
      .orderBy(desc(assistantMessage.id))
      .limit(200);
    const turn = turnOf(rows, req.id);
    if (!turn) throw APIError.invalidArgument("feedback goes under an answer of the assistant");

    const [row] = await db
      .insert(assistantFeedback)
      .values({
        user_id: Number(auth.userID),
        conversation_id: conversation.id,
        message_id: req.id,
        verdict: req.verdict,
        comment: comment || null,
        question: turn.question,
        trace: turn.trace,
        answer: message.content ?? "",
      })
      .onConflictDoUpdate({
        target: assistantFeedback.message_id,
        set: { verdict: req.verdict, comment: comment || null, trace: turn.trace, created_at: new Date().toISOString() },
      })
      .returning({ id: assistantFeedback.id, verdict: assistantFeedback.verdict });
    return row;
  },
);

export const listFeedback = api(
  { expose: true, method: "GET", path: "/assistant/feedback", auth: true },
  async (): Promise<{ entries: FeedbackEntry[] }> => {
    requirePermission(currentUser(), "data.manage");
    const rows = await db
      .select()
      .from(assistantFeedback)
      .orderBy(desc(assistantFeedback.created_at), desc(assistantFeedback.id))
      .limit(200);
    return { entries: rows.map(toEntry) };
  },
);

export const deleteFeedback = api(
  { expose: true, method: "DELETE", path: "/assistant/feedback/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ deleted: boolean }> => {
    requirePermission(currentUser(), "data.manage");
    const deleted = await db.delete(assistantFeedback).where(eq(assistantFeedback.id, id)).returning({ id: assistantFeedback.id });
    if (!deleted.length) throw APIError.notFound("feedback not found");
    return { deleted: true };
  },
);
