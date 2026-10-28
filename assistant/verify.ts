/**
 * The checker (documentation/plans/assistent-wegfindung.md, stage 5): one
 * short model call after the answer that holds it against the tool results
 * of the turn, bound to the tool `check_answer` like the router's
 * `choose_areas`, the plan's `write_plan` and the summary's `summarize_turn`.
 *
 * The regex checks in `agent.ts` (an amount without a tool call, a call
 * written as text, a request for consent in words) stay as a free
 * pre-filter: an answer reaches the checker only after it passed them. The
 * checker then catches what no regex can — a figure, a name or a row the
 * results do not hold, or a question answered from the wrong area's tools.
 * Its verdict goes back to the model once per kind; when the answer fails
 * the check twice, it goes out with a note that names what could not be
 * backed, instead of a third round.
 */

import { AREA_IDS, type AreaId, isAreaId } from "./areas";
import { toolDefinition } from "./catalog";
import type { ChatReply, ChatRequest } from "./llm-client";
import type { ChatMessage } from "./types";

export const CHECK_ANSWER_NAME = "check_answer";
/** What the check may spend: a verdict and one sentence. */
export const CHECK_TOKENS = 160;
/** Failed checks before the answer goes out with a note instead of another round. */
export const MAX_FAILED_CHECKS = 2;
/** Longer tool results are cut for the check; the figures of an answer are rarely past this. */
export const MAX_RESULT_CHARS = 6_000;
const MAX_MISSING_CHARS = 300;
const NO_AREA = "none";

/** Reads `ASSISTANT_VERIFY` at call time, so a test can switch it. Off only when set to "0". */
export function verifyByDefault(): boolean {
  return process.env.ASSISTANT_VERIFY !== "0";
}

export interface Verdict {
  grounded: boolean;
  /** What the answer states that the results do not hold, in the user's language; empty when grounded. */
  missing: string;
  /** The area whose tools the question needed and the turn did not use; null when the area was right. */
  wrongArea: AreaId | null;
}

export const checkAnswerDefinition = toolDefinition({
  name: CHECK_ANSWER_NAME,
  summary: "The verdict on the answer: whether every figure, name and row in it stands in the tool results, and whether the question belongs to another area.",
  parameters: {
    type: "object",
    properties: {
      grounded: {
        type: "boolean",
        description: "true when every figure, name, date and row the answer states is in a tool result or in the question; an answer that reports nothing found, asks a question or names a missing permission is grounded",
      },
      missing: {
        type: "string",
        maxLength: MAX_MISSING_CHARS,
        description: "when not grounded: one sentence in the user's language naming what the answer states that no result holds; empty when grounded",
      },
      wrong_area: {
        type: "string",
        enum: [NO_AREA, ...AREA_IDS],
        description: "the id of the area whose tools the question needs when none of them was used this turn; 'none' when the area was right or no tool was needed",
      },
    },
    required: ["grounded", "missing", "wrong_area"],
  },
});

const CHECK_PROMPT = `You check one answer of an assistant that reads a user's data through tools. Below are the user's question, the tool results of this turn (none when no tool was called) and the answer.

Call ${CHECK_ANSWER_NAME}. The answer is grounded when every amount, count, date, name and list row it states is in a tool result, or comes from the question itself; an answer that says nothing was found, that asks the user something, or that names a missing permission is grounded. It is not grounded when it states a figure, a name or a row that no result holds, or contradicts a result. Then name in "missing", in the user's language, what the answer states that the results do not hold — one sentence, nothing else. An answer that says nothing was found while a result holds matching rows is also not grounded. A write tool's call (render_letter, create_text_document, create_collection …) is the proposal the user gets: when the answer says the letter or document names or contains something — a number, a deadline, an amount — that must stand in the arguments of that call (shown in the result's header), not only in another result; otherwise the answer is not grounded and "missing" names it.

The areas of the system and their tools are listed below. When the question asks about an area whose tools were not used this turn and the answer was given anyway, put that area's id into "wrong_area"; otherwise "none".

Not your task: style, length, advice, or whether the user liked the answer.`;

export interface CheckInput {
  question: string;
  /** The tool results of this turn, with the tool that produced each. */
  results: Array<{ tool: string; arguments: string; content: string }>;
  answer: string;
  /** The areas whose tools were in play, and the others with their descriptions. */
  areas: Array<{ id: AreaId; description: string; tools: string[]; inPlay: boolean }>;
}

function cut(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (cut for the check)` : text;
}

/** The request of the check: a prompt of its own, no history, the bound tool. */
export function checkRequest(input: CheckInput): ChatRequest {
  const results = input.results.length
    ? input.results.map((r, i) => `Result ${i + 1}, ${r.tool}(${r.arguments}):\n${cut(r.content)}`).join("\n\n")
    : "(no tool was called this turn)";
  const areas = input.areas.map((a) => `- ${a.id}${a.inPlay ? " (used this turn)" : ""}: ${a.description} Tools: ${a.tools.join(", ") || "none for this user"}`).join("\n");
  const body = `Question:\n${input.question}\n\nTool results:\n${results}\n\nAnswer:\n${input.answer}\n\nAreas:\n${areas}`;
  return {
    messages: [{ role: "system", content: CHECK_PROMPT }, { role: "user", content: body }],
    tools: [checkAnswerDefinition],
    tool_choice: { type: "function", function: { name: CHECK_ANSWER_NAME } },
    max_tokens: CHECK_TOKENS,
    temperature: 0,
  };
}

export function isCheckRequest(req: ChatRequest): boolean {
  const choice = req.tool_choice;
  return typeof choice === "object" && choice !== null && choice.function?.name === CHECK_ANSWER_NAME;
}

/** The verdict the model gave; null when it gave none the loop can use (the answer then stands). */
export function parseVerdict(reply: Pick<ChatReply, "tool_calls">): Verdict | null {
  const call = reply.tool_calls.find((c) => c.function.name === CHECK_ANSWER_NAME);
  if (!call) return null;
  try {
    const parsed = JSON.parse(call.function.arguments || "{}") as { grounded?: unknown; missing?: unknown; wrong_area?: unknown };
    if (typeof parsed.grounded !== "boolean") return null;
    const missing = typeof parsed.missing === "string" ? parsed.missing.replace(/\s+/g, " ").trim().slice(0, MAX_MISSING_CHARS) : "";
    const wrongArea = isAreaId(parsed.wrong_area) ? parsed.wrong_area : null;
    return { grounded: parsed.grounded, missing, wrongArea };
  } catch {
    return null;
  }
}

/**
 * The tool results of a turn as the check reads them: each tool message with
 * the call that produced it. Meta tools (the plan, describe_tools,
 * switch_area) are left out, since they return no data.
 */
export function turnResults(turn: ChatMessage[], skip: Set<string>): CheckInput["results"] {
  const calls = new Map<string, { tool: string; arguments: string }>();
  for (const m of turn) {
    if (m.role !== "assistant") continue;
    for (const c of m.tool_calls ?? []) calls.set(c.id, { tool: c.function.name, arguments: c.function.arguments });
  }
  const results: CheckInput["results"] = [];
  for (const m of turn) {
    if (m.role !== "tool") continue;
    const call = calls.get(m.tool_call_id);
    if (!call || skip.has(call.tool)) continue;
    results.push({ ...call, content: typeof m.content === "string" ? m.content : "" });
  }
  return results;
}

/** Sent back once when the check found a claim the results do not hold. */
export function ungroundedNudge(missing: string): string {
  const what = missing || "a figure, name or row that no tool result holds";
  return `A check of your answer against the tool results above found a claim they do not hold: ${what}. Rewrite the answer from the results alone and drop what they do not hold, or call the tool that returns what is missing; if no tool can, say in words what you could not find. Never fill the gap from memory.`;
}

/** Sent back once when the check found the question belongs to an area whose tools were not used; `pkg` is that area's package. */
export function wrongAreaNudge(area: AreaId, pkg: string): string {
  return `A check of your answer found the question is about ${area}, whose tools were not used this turn. They are offered now:\n\n${pkg}\n\nCall the tool that answers the question; answer from its result.`;
}

/**
 * The note under an answer that failed the check twice: the user reads what
 * the assistant could not back, instead of a third attempt or a bare refusal.
 */
export function unverifiedNote(missing: string): string {
  const what = missing || "einzelne Angaben";
  return `_Hinweis: Diese Angabe konnte ich nicht in den gelesenen Daten belegen: ${what.replace(/[.\s]+$/, "")}._`;
}
