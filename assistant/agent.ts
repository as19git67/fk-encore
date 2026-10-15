/**
 * The agent loop (documentation/plans/ki-assistent.md, stage 2).
 *
 * One question becomes up to `maxRounds` calls to llm-service's /chat. Each
 * round the model either answers or asks for tools; the tools run here, as
 * the asking user, through the services' own endpoints, and their compact
 * results go back as `tool` messages. The loop ends on an answer without tool
 * calls, on the round cap (the last round forbids tools, so it must answer),
 * or when nothing more fits the context.
 *
 * The model never does arithmetic and never sees the database: every number
 * in an answer has to come from a tool result, and every tool is a service
 * call the user could have made through the app.
 */

import { resolveRelativeTimespan } from "../finance/llm-client";
import {
  catalogLines,
  describeTools,
  describeToolsDefinition,
  DESCRIBE_TOOLS_NAME,
  estimateTokens,
  mayUse,
  toolDefinition,
} from "./catalog";
import { ContextTooLargeError, type ChatFn, type ChatReply } from "./llm-client";
import type {
  AssistantUser,
  ChatMessage,
  ResultBlock,
  ToolSpec,
  TurnEvent,
} from "./types";

export const DEFAULT_MAX_ROUNDS = 8;
/** What one answer may spend on generation. */
const ANSWER_TOKENS = 1024;
/** The window the loop budgets against; the deployment's LLM_CTX, minus headroom. */
const DEFAULT_CONTEXT_TOKENS = Number.parseInt(process.env.ASSISTANT_CONTEXT_TOKENS ?? "12000", 10);
/**
 * Up to this size every schema goes along with every request; past it the
 * model gets the one-line catalog and fetches schemas with describe_tools.
 */
const DEFAULT_SCHEMA_BUDGET = Number.parseInt(process.env.ASSISTANT_SCHEMA_BUDGET_TOKENS ?? "3500", 10);

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Today and the periods people say, resolved, so the model never computes a date. */
export function timeGrounding(now: Date): string {
  const span = (type: "this_month" | "last_month" | "this_year" | "last_year") => {
    const r = resolveRelativeTimespan({ type }, now);
    return `${r.from}..${r.to}`;
  };
  return [
    `Today is ${WEEKDAYS[now.getDay()]}, ${localIso(now)}.`,
    `"this month" = ${span("this_month")}; "last month" = ${span("last_month")};`,
    `"this year" = ${span("this_year")}; "last year" = ${span("last_year")}.`,
  ].join("\n");
}

const RULES = `You are the assistant of a private household server that keeps finance bookings, documents, photos, utility meters and trip plans. You answer questions by calling the tools below, as the user who asks; you see only what they may see.

Rules:
- Use tools for every fact. Never invent data, ids, names or numbers a tool did not return.
- Never do arithmetic yourself. Sums, counts and periods come from tools (analyze_spending, upcoming_direct_debits, consumption_report print them). If no tool computed a number, do not state it.
- Dates in tool arguments are ISO (YYYY-MM-DD); use the periods resolved below.
- Combine tools from different areas when the question needs it.
- The rows a tool returned are shown to the user beside your answer, so summarise rather than repeat every row; name what fits the question and what does not.
- If a tool finds nothing, say so plainly and suggest how to search differently.
- Answer briefly in the user's language (usually German).`;

const EXAMPLES = `Examples of chained calls:
1. "Welche Lastschriften muss ich diesen Monat noch erwarten?" → upcoming_direct_debits(until = end of this month) → answer with the debits and the sum the tool printed.
2. "Gib mir die Protokolle der Eigentümerversammlung der Wohnung in Musterstadt." → list_categories → search_documents(q = "Protokoll Eigentümerversammlung", category = the matching slug) → name the documents that fit.
3. "Wie viel Strom haben wir letztes Jahr verbraucht?" → list_meters → consumption_report(meter_id = the electricity meter, from/to = last year) → state the total the tool printed.`;

export function buildSystemPrompt(tools: ToolSpec[], now: Date, deferred: boolean): string {
  const catalog = tools.length
    ? catalogLines(tools)
    : "(no tools — the user has no module the assistant can read)";
  const how = deferred
    ? `Tools you may call (fetch a tool's argument schema with ${DESCRIBE_TOOLS_NAME} before its first call):`
    : "Tools you may call:";
  return [RULES, timeGrounding(now), `${how}\n${catalog}`, EXAMPLES].join("\n\n");
}

export interface TurnInput {
  user: AssistantUser;
  /** Earlier turns of the conversation, oldest first (user and assistant text). */
  history: ChatMessage[];
  question: string;
  /** The catalog this user may use. */
  tools: ToolSpec[];
  chat: ChatFn;
  emit?: (event: TurnEvent) => void;
  now?: Date;
  maxRounds?: number;
  contextTokens?: number;
  schemaBudgetTokens?: number;
  /** Wraps each /chat call, e.g. in the ai-queue's llm slot. */
  withSlot?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Per tool call: name, argument keys and row count — never row content. */
  log?: (entry: { tool: string; arguments: Record<string, unknown>; rows: number; ms: number; error?: string }) => void;
}

export interface TurnResult {
  answer: string;
  blocks: ResultBlock[];
  /** The turn's messages after the history: question, tool rounds, answer. */
  transcript: ChatMessage[];
  rounds: number;
}

/**
 * Shrinks `messages` in place until they fit: first tool results older than
 * `protectFrom` become their one-line digests, then the oldest history turns
 * (between the system prompt and the question at `questionIndex`) go. The
 * system prompt, the question and everything after it always stay. Returns
 * how many history messages were removed, so the caller can shift indexes.
 */
export function fitContext(
  messages: ChatMessage[],
  digests: Map<string, string>,
  budget: number,
  bounds: { protectFrom: number; questionIndex: number },
  extraTokens = 0,
): number {
  const size = () => estimateTokens(messages) + extraTokens;
  for (let i = 1; i < bounds.protectFrom && size() > budget; i++) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    const digest = digests.get(m.tool_call_id);
    if (digest && m.content !== digest) messages[i] = { ...m, content: digest };
  }
  let removed = 0;
  while (size() > budget && bounds.questionIndex - removed > 1) {
    messages.splice(1, 1);
    removed++;
  }
  return removed;
}

function parseArguments(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const now = input.now ?? new Date();
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const budget = (input.contextTokens ?? DEFAULT_CONTEXT_TOKENS) - ANSWER_TOKENS;
  const emit = input.emit ?? (() => {});
  const withSlot = input.withSlot ?? ((fn) => fn());
  const tools = input.tools.filter((t) => mayUse(t, input.user));

  const allDefinitions = tools.map(toolDefinition);
  const deferred = estimateTokens(allDefinitions) > (input.schemaBudgetTokens ?? DEFAULT_SCHEMA_BUDGET);
  const offered = new Map<string, ToolSpec>(deferred ? [] : tools.map((t) => [t.name, t]));

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(tools, now, deferred) },
    ...input.history,
    { role: "user", content: input.question },
  ];
  let questionIndex = messages.length - 1;
  let lastRoundStart = questionIndex;
  const digests = new Map<string, string>();
  const blocks: ResultBlock[] = [];
  const ctx = { user: input.user, today: localIso(now) };

  let answer: string | null = null;
  let rounds = 0;
  for (let round = 1; round <= maxRounds && answer === null; round++) {
    rounds = round;
    const last = round === maxRounds;
    const definitions = [
      ...(deferred ? [describeToolsDefinition] : []),
      ...[...offered.values()].map(toolDefinition),
    ];
    // The previous round's results stay whole; older ones may shrink.
    const shift = fitContext(messages, digests, budget, { protectFrom: lastRoundStart, questionIndex }, estimateTokens(definitions));
    questionIndex -= shift;
    lastRoundStart -= shift;

    const request = {
      messages: [...messages],
      tools: definitions.length ? definitions : undefined,
      tool_choice: definitions.length ? (last ? "none" as const : "auto" as const) : undefined,
      max_tokens: ANSWER_TOKENS,
    };
    let reply: ChatReply;
    try {
      reply = await withSlot(() => input.chat(request, (text) => emit({ type: "token", text })));
    } catch (err) {
      if (!(err instanceof ContextTooLargeError)) throw err;
      // The estimate was optimistic. Shrink everything that can shrink and
      // try this round once more.
      const cut = fitContext(
        messages, digests, Math.floor(budget * 0.6), { protectFrom: messages.length, questionIndex }, estimateTokens(definitions),
      );
      questionIndex -= cut;
      lastRoundStart -= cut;
      request.messages = [...messages];
      reply = await withSlot(() => input.chat(request, (text) => emit({ type: "token", text })));
    }

    if (!reply.tool_calls.length || last) {
      answer = reply.content ?? "";
      if (!answer.trim()) {
        answer = "Dazu habe ich keine Antwort gefunden.";
      }
      break;
    }

    lastRoundStart = messages.length;
    messages.push({ role: "assistant", content: reply.content, tool_calls: reply.tool_calls });
    for (const call of reply.tool_calls) {
      const name = call.function.name;
      const args = parseArguments(call.function.arguments);
      const result = (content: string) => messages.push({ role: "tool", tool_call_id: call.id, content });

      if (args === null) {
        result(`error: the arguments of ${name} are not a JSON object`);
        continue;
      }
      if (deferred && name === DESCRIBE_TOOLS_NAME) {
        const { text, described } = describeTools(args.names, tools);
        for (const t of described) offered.set(t.name, t);
        result(text);
        continue;
      }
      const tool = tools.find((t) => t.name === name);
      if (!tool || (deferred && !offered.has(name))) {
        result(tool
          ? `error: call ${DESCRIBE_TOOLS_NAME} for ${name} first`
          : `error: ${name} is not in the catalog`);
        continue;
      }

      emit({ type: "tool_start", tool: name, arguments: args });
      const started = Date.now();
      try {
        const outcome = await tool.run(args, ctx);
        digests.set(call.id, outcome.digest);
        if (outcome.block) blocks.push(outcome.block);
        result(outcome.text);
        emit({ type: "tool_result", tool: name, rowCount: outcome.rowCount, block: outcome.block });
        input.log?.({ tool: name, arguments: args, rows: outcome.rowCount, ms: Date.now() - started });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result(`error: ${name} failed: ${message}`);
        emit({ type: "tool_result", tool: name, rowCount: 0, error: message });
        input.log?.({ tool: name, arguments: args, rows: 0, ms: Date.now() - started, error: message });
      }
    }
  }

  const final = answer ?? "Ich konnte die Frage nicht in der vorgesehenen Zahl von Schritten beantworten.";
  messages.push({ role: "assistant", content: final });
  const transcript = messages.slice(questionIndex);
  emit({ type: "done", answer: final, blocks });
  return { answer: final, blocks, transcript, rounds };
}
