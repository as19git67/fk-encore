/**
 * The summary of a turn (documentation/plans/assistent-wegfindung.md,
 * stage 4): two or three sentences the model writes after its answer, saying
 * what was asked, what the tools found and what the answer said.
 *
 * Earlier turns are replayed into every later request as they happened:
 * question, tool calls with their results, answer. That keeps the rows a
 * follow-up may still ask about, but a result of forty rows costs a thousand
 * tokens every round, so older results shrank to a one-line digest ("37
 * rows, ids …") the moment the window ran short — and a question about an
 * older turn met a list of ids. A summary keeps the substance (the sender,
 * the period, the sum, what was proposed) in a few lines; the rows
 * themselves stay reachable through `from_previous_result`, which reads
 * the stored result sets, not the transcript.
 *
 * The summary is one model call bound to the tool `summarize_turn`, like the
 * router's `choose_areas` and the plan's `write_plan`: a bound call works on
 * both llm-service backends. It runs after the answer has gone out, so it
 * never delays it, and a failure leaves the turn as it was — replayed whole,
 * shrunk to digests when needed.
 */

import { toolDefinition } from "./catalog";
import type { ChatFn, ChatReply, ChatRequest } from "./llm-client";
import type { ChatMessage } from "./types";

export const SUMMARIZE_TURN_NAME = "summarize_turn";
/** What the summary call may spend; three sentences fit well inside. */
export const SUMMARY_TOKENS = 240;
/** Longer than this and the summary saves nothing over the turn it replaces. */
export const MAX_SUMMARY_CHARS = 700;
const MIN_SUMMARY_CHARS = 20;

export const summarizeTurnDefinition = toolDefinition({
  name: SUMMARIZE_TURN_NAME,
  summary: "The memory note of this exchange, for the turns that follow.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        minLength: MIN_SUMMARY_CHARS,
        maxLength: MAX_SUMMARY_CHARS,
        description: "two or three sentences in the user's language: what was asked, what the tools found (names, dates, figures, how many rows), what the answer said or proposed",
      },
    },
    required: ["summary"],
  },
});

const SUMMARY_PROMPT = `You write the memory note of one exchange between a user and an assistant that reads the user's data through tools. The exchange follows: the question, the tool calls with what they returned, the answer.

Call ${SUMMARIZE_TURN_NAME} with two or three sentences in the user's language (usually German). Say what the user asked — put a reference to earlier rows ("davon", "diese") into words —, what the tools found: the names, dates, sums and other figures the answer rested on and how many rows there were, and what the answer said or proposed. Only facts from the tool results and the answer; never ids, never tool names, no advice, no greeting.`;

/** The request of the summary call: the turn as it happened, then the bound tool. */
export function summaryRequest(turn: ChatMessage[]): ChatRequest {
  return {
    messages: [{ role: "system", content: SUMMARY_PROMPT }, ...turn],
    tools: [summarizeTurnDefinition],
    tool_choice: { type: "function", function: { name: SUMMARIZE_TURN_NAME } },
    max_tokens: SUMMARY_TOKENS,
    temperature: 0.2,
  };
}

export function isSummaryRequest(req: ChatRequest): boolean {
  return req.tools?.length === 1
    && (req.tools[0] as { function?: { name?: string } }).function?.name === SUMMARIZE_TURN_NAME;
}

/** The summary the model wrote; null when it wrote nothing usable. */
export function parseSummary(reply: Pick<ChatReply, "tool_calls">): string | null {
  const call = reply.tool_calls.find((c) => c.function.name === SUMMARIZE_TURN_NAME);
  if (!call) return null;
  try {
    const parsed = JSON.parse(call.function.arguments || "{}") as { summary?: unknown };
    if (typeof parsed.summary !== "string") return null;
    const text = parsed.summary.replace(/\s+/g, " ").trim();
    if (text.length < MIN_SUMMARY_CHARS) return null;
    return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…` : text;
  } catch {
    return null;
  }
}

/** What a tool's digest says it held: a row count, a proposal, or nothing to say. */
function digestSuffix(digest: string | null): string {
  const rows = digest?.match(/(\d+) rows?\b/);
  if (rows) return ` (${rows[1]} row${rows[1] === "1" ? "" : "s"})`;
  if (digest && /\bproposal #\d+/.test(digest)) return " (proposal)";
  return "";
}

/**
 * The line under a replayed summary that keeps what the digests kept: which
 * tools ran and how many rows each found, and the way back to those rows.
 * Prose would be copied into answers; a bracketed note is what the loop
 * already strips from an answer and sends back (`agent.ts`).
 */
export function summaryNote(results: Array<{ tool: string; digest: string | null }>): string {
  const tools = results.map((r) => `${r.tool}${digestSuffix(r.digest)}`);
  const then = tools.length ? `; tools then: ${tools.join(", ")}` : "";
  return `[summary of an earlier turn${then}. Follow-ups on those rows use from_previous_result.]`;
}

/** An older turn as later requests see it: the question, and the summary with its note in the answer's place. */
export function summarizedTurn(question: string, summary: string, note: string): ChatMessage[] {
  return [
    { role: "user", content: question },
    { role: "assistant", content: `${summary}\n\n${note}` },
  ];
}

/**
 * Asks the model for the summary of `turn` (question, tool rounds, answer).
 * Null when the model wrote nothing usable; the caller then keeps the turn
 * as it is.
 */
export async function summarizeTurn(chat: ChatFn, turn: ChatMessage[], signal?: AbortSignal): Promise<string | null> {
  const reply = await chat(summaryRequest(turn), undefined, signal);
  return parseSummary(reply);
}
