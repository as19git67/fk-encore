/**
 * The "Assistent schreiben lassen" of the text-document editor: the user
 * says what to write, the assistant writes it, the editor inserts it.
 *
 * It runs the same agent loop as the chat, read tools only, so a text about
 * the user's own data ("Zusammenfassung meiner Stromkosten 2025") comes from
 * tool results rather than from the model's imagination. Nothing is stored:
 * no conversation, no proposal — the text goes back to the form, and the
 * user decides what to keep.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import log from "encore.dev/log";
import { requirePermission } from "../user/auth-handler";
import { checkRateLimit } from "../user/rateLimiter";
import { AI_PRIORITY, AiSlotTimeoutError, withAiPriority, withAiSlot } from "../ai-queue/slot-helper";
import { NO_ROWS_MARKER, runTurn } from "./agent";
import { catalogFor } from "./catalog";
import { chat, ContextTooLargeError, LlmServiceUnavailableError } from "./llm-client";

const MAX_INSTRUCTION = 2000;
/** The document so far, as context; more than this is cut from the middle. */
const MAX_CONTEXT_TEXT = 12_000;
/** Shares the chat's budget: each request may cost several model rounds. */
const RATE_LIMIT = { maxAttempts: 20, windowMs: 10 * 60_000 };

export interface ComposeTextRequest {
  /** What to write: "eine Einladung zum Grillfest am Samstag". */
  instruction: string;
  /** The document's title, if it has one yet. */
  title?: string;
  /** The text so far, when the user wants it taken into account. */
  text?: string;
}

export interface ComposeTextResponse {
  /** The text the assistant wrote, in Markdown. */
  markdown: string;
}

/** Keeps the start and the end of a long text: where it began and where the user is. */
function excerpt(text: string): string {
  if (text.length <= MAX_CONTEXT_TEXT) return text;
  const half = Math.floor(MAX_CONTEXT_TEXT / 2);
  return `${text.slice(0, half)}\n\n[… ${text.length - 2 * half} Zeichen ausgelassen …]\n\n${text.slice(-half)}`;
}

/** The question the agent gets: the instruction, the document so far, and the form the answer must take. */
export function composeQuestion(req: ComposeTextRequest): string {
  const parts = [
    "Write text for a document the user is writing in the app. Your answer is inserted into the document as it is.",
    "Answer with the document text only, in Markdown (headings, lists, tables where they help) — no preamble like \"Hier ist …\", no closing remark, no code fence around it, and no title heading unless the instruction asks for one.",
    "Facts about the user's data come from tools; where one is needed and no tool has it, write [[what is missing]] instead of guessing.",
    "Write in the language of the instruction (usually German).",
  ];
  const title = req.title?.trim();
  if (title) parts.push(`Title of the document: ${title}`);
  const text = req.text?.trim();
  if (text) parts.push(`The document so far:\n<<<\n${excerpt(text)}\n>>>`);
  parts.push(`Instruction: ${req.instruction.trim()}`);
  return parts.join("\n\n");
}

/** Strips what a model wraps text in despite being asked not to: a code fence, a lead-in line, the no-rows marker. */
export function cleanComposed(answer: string): string {
  let t = answer.replace(NO_ROWS_MARKER, "").trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(t);
  if (fence) t = fence[1].trim();
  t = t.replace(/^(hier ist|hier sind|gerne[,!]?|klar[,!]?)[^\n]*:\s*\n+/i, "");
  return t.trim();
}

export const composeText = api(
  { expose: true, method: "POST", path: "/assistant/compose", auth: true },
  async (req: ComposeTextRequest): Promise<ComposeTextResponse> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("not signed in");
    requirePermission(auth, "module.assistant");
    const instruction = req.instruction?.trim() ?? "";
    if (!instruction) throw APIError.invalidArgument("instruction is empty");
    if (instruction.length > MAX_INSTRUCTION) {
      throw APIError.invalidArgument(`instruction is longer than ${MAX_INSTRUCTION} characters`);
    }
    checkRateLimit(`assistant:${auth.userID}`, { ...RATE_LIMIT, message: "Too many questions to the assistant." });

    const user = { userID: auth.userID, permissions: auth.permissions };
    try {
      const result = await withAiPriority(AI_PRIORITY.assistant, () => runTurn({
        user,
        history: [],
        question: composeQuestion({ ...req, instruction }),
        // Read tools only: writing the text must not file or change anything.
        tools: catalogFor(user).filter((t) => t.kind === "read"),
        chat,
        withSlot: (fn) => withAiSlot("llm", AI_PRIORITY.assistant, "assistant-compose", fn),
      }));
      const markdown = cleanComposed(result.answer);
      if (!markdown) throw APIError.internal("the assistant wrote nothing");
      log.info("assistant composed text", { rounds: result.rounds, chars: markdown.length });
      return { markdown };
    } catch (err) {
      if (err instanceof LlmServiceUnavailableError || err instanceof AiSlotTimeoutError) {
        throw APIError.unavailable("the assistant's model is busy or reloading — try again in a moment");
      }
      if (err instanceof ContextTooLargeError) {
        throw APIError.failedPrecondition("the text is too long for the model — shorten it or leave it out");
      }
      if (err instanceof APIError) throw err;
      log.error(err, "assistant compose failed");
      throw APIError.internal("the assistant could not write the text");
    }
  },
);
