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
import { contextSection, type ContextRef } from "./briefs";
import { ContextTooLargeError, type ChatFn, type ChatReply } from "./llm-client";
import type {
  AssistantUser,
  ChatMessage,
  RefType,
  ResultBlock,
  ResultRef,
  ToolSpec,
  TurnEvent,
} from "./types";

export const DEFAULT_MAX_ROUNDS = 8;
/** What the loop says itself when the model gave no answer; never the model's words. */
export const NO_ANSWER = "Dazu habe ich keine Antwort gefunden.";
export const OUT_OF_ROUNDS = "Ich konnte die Frage nicht in der vorgesehenen Zahl von Schritten beantworten.";
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
- Earlier answers end with a note of the tools behind them and what they found. For a follow-up on those rows ("davon", "nur die aus …", "mach daraus …") pass from_previous_result: true to a tool that offers it instead of searching again.
- Tools of kind "write" never change anything: they create a proposal the user confirms with a button. Call one only when the user asks for that change, then say what you proposed and that it waits for their confirmation. Never claim it is done.
- For a letter (Anschreiben, Antwort, Widerspruch, Kündigung …) call render_letter with the whole text: salutation, body and closing. Take every fact — names, dates, amounts, reference numbers — from the working set or a tool result. Where the letter needs a fact you do not have, write a gap as [[what is missing]] instead of guessing; the user fills it in on the card.
- Answer briefly in the user's language (usually German).`;

const EXAMPLES = `Examples of chained calls:
1. "Welche Lastschriften muss ich diesen Monat noch erwarten?" → upcoming_direct_debits(until = end of this month) → answer with the debits and the sum the tool printed.
2. "Gib mir die Protokolle der Eigentümerversammlung der Wohnung in Musterstadt." → list_categories → search_documents(q = "Protokoll Eigentümerversammlung", category = the matching slug) → name the documents that fit.
3. "Wie viel Strom haben wir letztes Jahr verbraucht?" → list_meters → consumption_report(meter_id = the electricity meter, from/to = last year) → state the total the tool printed.
4. "Leg ein Album mit allen Favoriten von 2025 an." → create_album(name = "Favoriten 2025", photos = {favorite: true, date_from: "2025-01-01", date_to: "2025-12-31"}) → say the album is proposed with the count the tool printed and waits for "Ausführen".
5. After an answer listing photos: "Nur die aus München, und mach daraus ein Album." → list_photos(from_previous_result = true, place = "München") → create_album(name = …, from_previous_result = true) → say what was proposed.
6. After an answer listing documents of a purchase: "Schwärze den Kaufpreis und mach ein PDF daraus." → find the price first if it is not known (get_document_summary of the contract) → create_collection(name = …, from_previous_result = true, redact = [the price as printed, e.g. "450.000,00"]) → say how many pages get blacked out, name documents without word positions, and that the boxes should be checked in the Sammelmappe before passing the PDF on.
7. "Liste alle Buchungen zur Wohnung mit Zwischensummen für Kauf, Reparatur und Mieteinnahmen und ermittle die Rendite." → list_transactions (as needed) → transaction_report(title = …, groups = [{name: "Kauf", transaction_ids: […]}, {name: "Reparatur", …}, {name: "Mieteinnahmen", tag: "Miete"}], transaction_ids = all bookings found, yield = {investment_group: "Kauf", income_groups: ["Mieteinnahmen"], cost_groups: ["Reparatur"]}) → repeat only the subtotals and the yield formula the tool printed, and name bookings whose group was doubtful.
8. Working set of three invoices: "Schreib dem Absender, dass ich die drei Rechnungen bezahlt habe." → render_letter(recipient = the sender's address if a tool showed it, else [[Anschrift des Absenders]], subject = "Ihre Rechnungen …" with their numbers, body = salutation, one line per invoice with number, date and amount from the working set, [[Zahlungsdatum]] where the date of payment is unknown, closing) → say the letter waits on the card and name the gaps to fill.`;

export function buildSystemPrompt(tools: ToolSpec[], now: Date, deferred: boolean, briefs: string[] = []): string {
  const catalog = tools.length
    ? catalogLines(tools)
    : "(no tools — the user has no module the assistant can read)";
  const how = deferred
    ? `Tools you may call (fetch a tool's argument schema with ${DESCRIBE_TOOLS_NAME} before its first call):`
    : "Tools you may call:";
  const working = contextSection(briefs);
  return [RULES, timeGrounding(now), ...(working ? [working] : []), `${how}\n${catalog}`, EXAMPLES].join("\n\n");
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
  /** The conversation the turn belongs to; proposals are filed under it. */
  conversationId?: number;
  /** The latest result sets of earlier turns, by type. */
  previousRefs?: Partial<Record<RefType, number[]>>;
  /** The working set the user handed over, and a brief of each object (#1534). */
  context?: { refs: ContextRef[]; briefs: string[] };
  /** Per tool call: name, argument keys and row count — never row content. */
  log?: (entry: { tool: string; arguments: Record<string, unknown>; rows: number; ms: number; error?: string }) => void;
}

export interface TurnResult {
  answer: string;
  blocks: ResultBlock[];
  /** The turn's messages after the history: question, tool rounds, answer. */
  transcript: ChatMessage[];
  /** Per tool call id: its one-line digest and the set it found, for later turns. */
  toolResults: Record<string, { digest: string; ref?: ResultRef }>;
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
    { role: "system", content: buildSystemPrompt(tools, now, deferred, input.context?.briefs) },
    ...input.history,
    { role: "user", content: input.question },
  ];
  let questionIndex = messages.length - 1;
  let lastRoundStart = questionIndex;
  const digests = new Map<string, string>();
  const blocks: ResultBlock[] = [];
  const refs = new Map<RefType, number[]>(
    Object.entries(input.previousRefs ?? {}) as Array<[RefType, number[]]>,
  );
  // Without an earlier result of a type, "these" means the working set's.
  for (const r of input.context?.refs ?? []) {
    if (input.previousRefs?.[r.type]) continue;
    refs.set(r.type, [...(refs.get(r.type) ?? []), r.id]);
  }
  const toolResults: TurnResult["toolResults"] = {};
  const ctx = {
    user: input.user,
    today: localIso(now),
    conversationId: input.conversationId,
    previous: (type: RefType) => refs.get(type),
    context: input.context?.refs ?? [],
  };

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
        answer = NO_ANSWER;
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
        toolResults[call.id] = { digest: outcome.digest, ref: outcome.ref };
        if (outcome.ref) refs.set(outcome.ref.type, outcome.ref.ids);
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

  const final = answer ?? OUT_OF_ROUNDS;
  messages.push({ role: "assistant", content: final });
  const transcript = messages.slice(questionIndex);
  emit({ type: "done", answer: final, blocks });
  return { answer: final, blocks, transcript, rounds, toolResults };
}
