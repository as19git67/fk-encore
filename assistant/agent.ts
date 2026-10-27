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
import { accessSection, saysPermissionMissing, userAccess } from "./access";
import { checkRequest, MAX_FAILED_CHECKS, parseVerdict, turnResults, ungroundedNudge, unverifiedNote, wrongAreaNudge, type Verdict } from "./verify";
import { argumentError, checkArguments } from "./arguments";
import { AREAS, AREA_IDS, areaById, homeOf, toolsOfArea, type Area, type AreaId } from "./areas/index";
import { route, type RoutingStage } from "./router";
import { contextSection, type ContextRef } from "./briefs";
import { ContextTooLargeError, MalformedReplyError, type ChatFn, type ChatReply, type ChatRequest, type ForcedTool } from "./llm-client";
import type {
  AssistantUser,
  ChatMessage,
  ContextUsage,
  RefType,
  ResultBlock,
  ResultRef,
  ToolOutcome,
  ToolSpec,
  TurnEvent,
} from "./types";

export const DEFAULT_MAX_ROUNDS = 8;
/** What the loop says itself when the model gave no answer; never the model's words. */
export const NO_ANSWER = "Dazu habe ich keine Antwort gefunden.";
export const OUT_OF_ROUNDS = "Ich konnte die Frage nicht in der vorgesehenen Zahl von Schritten beantworten.";
/** What one answer may spend on generation. */
const ANSWER_TOKENS = 1024;
/**
 * The loop budgets against the model's own window, which llm-service names
 * with every reply (n_ctx), less headroom for the answer and for the error
 * of its estimate. ASSISTANT_CONTEXT_TOKENS pins a fixed budget instead
 * (in estimated tokens); until the window is known — the first round after
 * a restart — the fallback holds. The tool schemas count against it on
 * every round (about 6100 tokens with every module).
 */
const FIXED_CONTEXT_TOKENS = process.env.ASSISTANT_CONTEXT_TOKENS
  ? Number.parseInt(process.env.ASSISTANT_CONTEXT_TOKENS, 10)
  : null;
const FALLBACK_CONTEXT_TOKENS = 20000;
/** Share of the window kept free for the chat template and a misjudged estimate. */
const WINDOW_HEADROOM = 0.05;

/**
 * Real tokens per estimated token (characters / 4), learnt from what the
 * model counted: German text and JSON rows do not tokenize alike, and a
 * budget in estimated tokens is only as good as this ratio. Shared by all
 * turns of the process, smoothed, and kept within reason.
 */
let tokensPerEstimate = 1;

export function calibrateEstimate(estimated: number, counted: number): void {
  // Small requests say more about the template than about the text.
  if (estimated < 500 || counted <= 0) return;
  const sample = Math.min(2, Math.max(0.5, counted / estimated));
  tokensPerEstimate = 0.7 * tokensPerEstimate + 0.3 * sample;
}

export function __resetCalibrationForTests(): void {
  tokensPerEstimate = 1;
}

/** What a request may take of `window` real tokens, in estimated tokens, the answer's share already off. */
export function budgetForWindow(window: number): number {
  return Math.floor((window * (1 - WINDOW_HEADROOM) - ANSWER_TOKENS) / tokensPerEstimate);
}

/**
 * Up to this size every schema goes along with every request; past it the
 * model gets the one-line catalog and fetches schemas with describe_tools.
 * The full catalog of a user with every module is about 10,400 tokens (49
 * tools, ranking and grouping on the three list tools and the photo book
 * included); the budget leaves room for a few more before a round goes to
 * fetching — and only a turn with every area in play sends the full
 * catalog, since the router (assistent-wegfindung.md) offers the areas'
 * tools. A deployment with a small
 * context window lowers it through the environment — and raises
 * ASSISTANT_CONTEXT_TOKENS along with the model's window, since the
 * schemas count against that budget on every round.
 */
const DEFAULT_SCHEMA_BUDGET = Number.parseInt(process.env.ASSISTANT_SCHEMA_BUDGET_TOKENS ?? "11000", 10);

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

/**
 * The line the model ends its answer with when the rows it found do not
 * answer the question (asked for flights, found coffee bills): the answer
 * says so in words, and the rows stay out of the chat. The prompt names it;
 * `cleanAnswer` removes it from what the user reads.
 */
export const NO_ROWS_MARKER = "[[ohne Liste]]";

export const SWITCH_AREA_NAME = "switch_area";

/** The meta-tool that adds an area's package (rules, tools, examples) to the turn. */
export const switchAreaDefinition = toolDefinition({
  name: SWITCH_AREA_NAME,
  summary: "Adds another area of the server to this turn: its rules, its tools and its examples. Call it before the first tool of that area.",
  parameters: {
    type: "object",
    properties: { area: { type: "string", enum: AREA_IDS, description: "the area to add" } },
    required: ["area"],
  },
});

/** What `switch_area` answers: the area's package, written for the model. */
export function areaPackage(area: Area, tools: ToolSpec[]): string {
  const own = tools.filter((t) => toolsOfArea(area).includes(t.name));
  const parts = [
    areaRulesSection(area),
    own.length ? `Tools of ${area.id}:\n${catalogLines(own)}` : `The user may use no tool of ${area.id}.`,
    examplesSection([area]),
  ];
  return parts.filter((p): p is string => !!p).join("\n\n");
}

// ─── the plan of a multi-step question (stage 3 of assistent-wegfindung.md) ──

/**
 * The same request without the grammar of a bound call: the tool list cut to
 * the bound tool, and the model free to call it or not. For an unbound
 * request, the request itself.
 */
export function unbound(request: ChatRequest): ChatRequest {
  const choice = request.tool_choice;
  const forced = typeof choice === "object" && choice !== null ? choice.function.name : choice === "required" ? null : undefined;
  if (forced === undefined) return request;
  const tools = forced === null ? request.tools : request.tools?.filter((t) => (t as { function?: { name?: string } }).function?.name === forced);
  return { ...request, tools, tool_choice: "auto" };
}

export const WRITE_PLAN_NAME = "write_plan";
/** What the plan call may spend on generation: a few short lines of JSON. */
const PLAN_TOKENS = 320;
/**
 * Let the model think before it plans. Off by default; set to try whether a
 * short reasoning block ahead of the plan buys more right first tools than
 * it costs in latency (the benchmark measures both).
 */
const PLAN_THINKING = process.env.ASSISTANT_PLAN_THINKING === "1";
const PLAN_STEPS_MIN = 1;
const PLAN_STEPS_MAX = 4;

export interface PlanStep {
  tool: string;
  goal: string;
  done: boolean;
}

/**
 * The tool the plan call is bound to: the grammar allows only steps that
 * name a tool offered this turn, so the plan cannot name a road that does
 * not exist. It stays in the catalog of the turn so the tool list, and
 * with it the cached prompt prefix, is the same in every round.
 */
export function writePlanDefinition(toolNames: string[]): unknown {
  return toolDefinition({
    name: WRITE_PLAN_NAME,
    summary: `The steps that answer the question, in the order they build on each other; ${PLAN_STEPS_MIN} to ${PLAN_STEPS_MAX} steps, each one tool call (one step when one call answers it). Written once, before the first tool.`,
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          minItems: PLAN_STEPS_MIN,
          maxItems: PLAN_STEPS_MAX,
          items: {
            type: "object",
            properties: {
              tool: { type: "string", enum: toolNames },
              goal: { type: "string", description: "what this step finds or makes, in a few words" },
            },
            required: ["tool", "goal"],
          },
        },
      },
      required: ["steps"],
    },
  });
}

/** The steps the model wrote, or null when the reply holds no usable plan. */
export function parsePlan(reply: ChatReply, allowed: Set<string>): PlanStep[] | null {
  const call = reply.tool_calls.find((c) => c.function.name === WRITE_PLAN_NAME);
  if (!call) return null;
  const args = parseArguments(call.function.arguments);
  if (!args || !Array.isArray(args.steps)) return null;
  const steps: PlanStep[] = [];
  for (const raw of args.steps) {
    const step = raw as { tool?: unknown; goal?: unknown } | null;
    if (!step || typeof step.tool !== "string" || !allowed.has(step.tool)) continue;
    steps.push({ tool: step.tool, goal: typeof step.goal === "string" ? step.goal.trim().slice(0, 120) : "", done: false });
    if (steps.length === PLAN_STEPS_MAX) break;
  }
  return steps.length >= PLAN_STEPS_MIN ? steps : null;
}

/** The plan as the model reads it back: a checklist and the next step. */
export function planText(steps: PlanStep[]): string {
  const lines = steps.map((s, i) => `[${s.done ? "x" : " "}] ${i + 1}. ${s.tool}${s.goal ? ` — ${s.goal}` : ""}`);
  return `Plan:\n${lines.join("\n")}\n${planStatus(steps)}`;
}

/** What is next: the first open step, or the answer once every step is done. */
export function planStatus(steps: PlanStep[]): string {
  const next = steps.findIndex((s) => !s.done);
  if (next < 0) return "Every planned step is done: answer now from the results above.";
  const step = steps[next]!;
  const done = steps.filter((s) => s.done).length;
  return `${done ? `Plan: ${done} of ${steps.length} steps done. ` : ""}Next: step ${next + 1}, ${step.tool}${step.goal ? ` — ${step.goal}` : ""}. Call it now; when every step is done, answer. Skip a step only when the results above already cover it.`;
}

/** Sent back once when the model answers with planned steps still open. */
export function planNudge(steps: PlanStep[]): string {
  const open = steps.map((s, i) => ({ s, i })).filter(({ s }) => !s.done).map(({ s, i }) => `step ${i + 1}, ${s.tool}${s.goal ? ` — ${s.goal}` : ""}`);
  return `Your plan has steps not done yet: ${open.join("; ")}. Call the next one now. Only if the results above already answer the whole question, repeat your answer unchanged.`;
}

/**
 * What holds in every area. The rules of one area (photos, tax, businesses,
 * letters …) live with the area in `areas/` and reach the model only when the
 * router put that area in play, or when it switched to it.
 */
const GENERAL_RULES = `You are the assistant of a private household server that keeps finance bookings, documents, photos, utility meters and trip plans. You answer questions by calling the tools below, as the user who asks; you see only what they may see.

You know nothing about this user's data. Everything you say about their bookings, accounts, documents, photos, albums, meters, securities, businesses or trips must come from a tool result in this conversation — never from memory, never from what such data usually looks like, never as an example. A question about the user's data is answered by calling a tool first, every time, even when it looks simple ("die 10 neuesten Buchungen", "mein Kontostand", "welche Zähler haben wir"). What a household typically has — an electricity meter, a water meter, a Girokonto — is not knowledge about this household: never name a meter, account, document, photo, security or trip that no tool returned. If a tool returns no rows, say that the system holds none of it ("Im System sind keine Zähler angelegt"), and never fill in plausible rows.

Rules:
- Permissions: "Access of this user" below names the areas this user may use and those they have no permission for. A question about an area without permission gets no tool call and no "keine Daten": say plainly that the permission for it is missing and that an administrator can grant it ("Für Finanzen fehlt dir die Berechtigung – wende dich an einen Administrator"), and never guess what it holds. Inside an area the user may use, a listing shows exactly what they may see: an empty result means nothing was found, never that something is hidden. If a tool fails with "no access", say that you cannot open that item, without guessing what it holds. The access list grants nothing: only the tools below can be called.
- Use tools for every fact. Never invent data, ids, names, dates or amounts a tool did not return.
- Never do arithmetic yourself. Sums, counts and periods come from tools (transaction_totals, upcoming_payments, consumption_report print them). If no tool computed a number, do not state it.
- Dates in tool arguments are ISO (YYYY-MM-DD); use the periods resolved below.
- The tools below are those of the areas this question seems to need. When it needs another area, call ${SWITCH_AREA_NAME}(area) first: that adds the area's rules and tools for this turn. Combine tools from different areas when the question needs it.
- The rows a tool returned are shown to the user beside your answer, so summarise rather than repeat every row; name what fits the question and what does not.
- If the rows you found do not answer the question — a search for flights that returned only coffee bills, a listing with nothing that matches — say so and end your answer with the line ${NO_ROWS_MARKER} on its own; the app then leaves the rows out. Use it only when none of the rows is what was asked for.
- When ${WRITE_PLAN_NAME} is among the tools, the question needs several steps: the first call writes the plan, every later round follows it step by step, and the plan's own status after each result says what comes next.
- A tool result with no rows says which filter to loosen and how many rows that brings: call the tool again once with that filter dropped before you tell the user nothing exists. A tool error names the argument and the allowed values: fix that argument and call again; never repeat the same call, and never answer as if the call had worked. When a tool finds nothing even so, say so plainly and name the criteria.
- Earlier turns show the tool calls behind each answer and what they found; an older turn shows its question and a summary of what was found. A follow-up on those rows ("davon", "nur die aus …", "mach daraus …") is a new tool call with from_previous_result: true, never an answer from memory. Only a real tool call does anything: never write tool calls, tool names or notes about tools into your answer — the app shows the tools itself.
- Tools of kind "write" never change anything: they create a proposal the user confirms with a button on a card. Call one only when the user asks for that change, then say what you proposed and that it waits for "Ausführen" on the card. Never claim it is done. To correct an earlier proposal (another layout, other text, other photos), call the write tool again with the changed arguments: that makes a new card under your answer, while the earlier card stays as it was and cannot be changed. Never ask for confirmation in words instead ("Soll ich …?", "Bitte bestätige …"): without the tool call there is no card and nothing the user could confirm — the card is the confirmation. If an earlier answer asked in words anyway and the user now says yes, call the write tool now.
- When a table helps (a few rows compared by the same columns), write it as a Markdown table: a header row, then a separator row like |---|---:|, one row per line. The app shows it as a real table. Never draw tables with +---+, box characters or spaces, and never put a table in a code block.
- When you name a single item by its id, put its kind right before the number: "Dokument 123", "Buchung 4711", "Album 12", "Sammelmappe 5", "Zähler 3", "Betrieb 2", or "Dokument „Titel“ (ID 123)". The app turns such a mention into a link to the item's page. Only name ids a tool printed.
- Answer briefly in the user's language (usually German).`;

/** The rule block of one area, as the prompt and `switch_area` print it; empty when the area adds no rule. */
export function areaRulesSection(area: Area): string | null {
  if (!area.rules.length) return null;
  return `Rules for ${area.id}:\n${area.rules.map((r) => `- ${r}`).join("\n")}`;
}

/** The examples of the areas in play, numbered through. */
export function examplesSection(areas: Area[]): string | null {
  const lines = areas.flatMap((a) => a.examples);
  if (!lines.length) return null;
  return `Examples of chained calls:\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;
}

/** The areas not in play, so the model knows what `switch_area` can add. */
export function otherAreasSection(areas: Area[]): string | null {
  if (!areas.length) return null;
  return `Other areas, added with ${SWITCH_AREA_NAME}(area):\n${areas.map((a) => `- ${a.id}: ${a.description}`).join("\n")}`;
}

/**
 * The system prompt of a turn. The fixed part comes first, so llama-server's
 * prompt cache reuses it across turns and users: the general rules, then the
 * day, then this user's access and working set, then the areas in play with
 * their rules, tools and examples, then the areas that are one call away.
 * `tools` are the tools offered in round 1; `areas` the areas in play (every
 * area when absent).
 */
export function buildSystemPrompt(
  tools: ToolSpec[],
  now: Date,
  deferred: boolean,
  briefs: string[] = [],
  permissions?: readonly string[],
  areas: readonly AreaId[] = AREA_IDS,
  otherAreas: readonly AreaId[] = [],
): string {
  const active = AREAS.filter((a) => areas.includes(a.id));
  const others = AREAS.filter((a) => otherAreas.includes(a.id));
  const catalog = tools.length
    ? catalogLines(tools)
    : "(no tools — the user has no module the assistant can read)";
  const how = deferred
    ? `Tools you may call (fetch a tool's argument schema with ${DESCRIBE_TOOLS_NAME} before its first call):`
    : "Tools you may call:";
  const working = contextSection(briefs);
  const access = permissions
    ? accessSection(userAccess(permissions), tools.filter((t) => t.kind === "write").map((t) => t.name))
    : null;
  const sections: Array<string | null> = [
    GENERAL_RULES,
    timeGrounding(now),
    access,
    working,
    ...active.map(areaRulesSection),
    `${how}\n${catalog}`,
    examplesSection(active),
    otherAreasSection(others),
  ];
  return sections.filter((s): s is string => !!s).join("\n\n");
}

/**
 * Sent back once when the model answers a turn without calling any tool but
 * its answer reads like the user's data: an amount, a date, a list. Models
 * fill such answers from memory when they skip the tool; this asks again.
 */
export const GROUNDING_NUDGE = "Your answer states amounts, dates or list rows about the user's data, but you called no tool in this turn. You do not know the user's data. Call the tool that returns it now. Only if every figure is already in an earlier tool result of this conversation, repeat your answer unchanged; if no tool can answer, say so.";

/**
 * Sent back once when the question is about the user's data (it names
 * meters, accounts, documents …) but the model answered without any tool
 * call. The answer may read like prose ("Sie haben einen Strom- und einen
 * Wasserzähler") and pass the data check above, and still be invented.
 */
export const DATA_QUESTION_NUDGE = "The question is about the user's data in this system, but you called no tool in this turn. You do not know this user's data, and what such data usually looks like does not apply here. Call the tool that lists or reads it now (list_meters, list_accounts, search_documents, list_photos, portfolio_overview, list_businesses, list_trip_plans …). If the question is about an area the access list names without permission, answer that the permission is missing instead. If no tool covers the question, say that the system holds no such data; if you need the user to choose first, ask that again unchanged. Never name items from memory.";

/**
 * Words that make a question one about the user's data: the things the
 * services keep, in German and English, with their usual compounds
 * (Zählerstand, Kontostand, Depotauszug …). A question with one of them
 * and no tool call behind its answer is sent back once.
 */
const DATA_TERMS_RE = new RegExp(
  "\\b(?:z[äa]hler|stromz|wasserz|gasz|verbrauch|meter|readings?|consumption|"
  + "konto|konten|kontostand|saldo|buchung|umsatz|umsätze|lastschrift|überweisung|account|balance|booking|transaction|debit|"
  + "dokument|unterlage|rechnung|vertrag|beleg|brief|protokoll|document|invoice|contract|receipt|"
  + "foto|bild|album|alben|photo|picture|"
  + "depot|wertpapier|aktie|fonds|etf|kurs|dividende|portfolio|position|security|securities|share|stock|quote|"
  + "betrieb|anlageg|anlagevermögen|afa|abschreibung|fläche|flurstück|pacht|pächter|business|asset|parcel|lease|"
  + "reise|reiseplan|urlaub|trip|"
  + "sammelmappe|basket|collection|"
  + "steuer|tax)",
  "i",
);

/** Is the question about what the system keeps for this user, rather than small talk or a how-to? */
export function isDataQuestion(question: string): boolean {
  return DATA_TERMS_RE.test(question);
}

/** Sent back when the model writes a tool call, or a note about one, as text instead of calling it. */
export const FAKE_CALL_NUDGE = "You wrote a tool call or a note about tools as text. That does nothing: nothing was looked up or proposed. Call the tool through the tool interface now, or answer in plain words without mentioning tools.";

/** Sent back when the model asks in words to confirm a change instead of proposing it. */
export const CONSENT_NUDGE = "You asked the user to confirm a change in words. Words cannot be confirmed: only a write tool creates the card with the button. If the user asked for the change, call the write tool now; the card is the confirmation. Otherwise answer without asking for confirmation.";

/** An answer that waits for the user's go-ahead ("Bitte bestätige …", "please confirm"). */
const CONSENT_RE = /bestätig|\bconfirm/i;

export function asksForConsent(text: string | null): boolean {
  return !!text && CONSENT_RE.test(text);
}

/**
 * Sent back when the model says it changed or proposed something in a turn
 * where no write tool ran: an earlier card stays as it was, so the user would
 * look for the "corrected" one above their own question and find the old one.
 */
export const REVISION_NUDGE = "You said you changed or proposed something, but no write tool ran in this turn. An earlier card cannot change: a correction is a new call of the write tool with the changed arguments, and that puts a new card under your answer. If the user asked for a change, call the write tool now. Otherwise answer without saying that something was changed or proposed.";

/** An answer that reports a change or a proposal as made ("Ich habe die Collage angepasst"). */
const CLAIMS_CHANGE_RE = /(?<!\p{L})(?:angepasst|korrigiert|geändert|aktualisiert|überarbeitet|neu erstellt|erneut erstellt|vorgeschlagen|updated|adjusted|corrected|changed|revised|proposed)(?!\p{L})/iu;

export function claimsChange(text: string | null): boolean {
  return !!text && CLAIMS_CHANGE_RE.test(text);
}

/** An earlier turn of the conversation ended with a proposal card. */
function proposedEarlier(history: ChatMessage[], writeTools: Set<string>): boolean {
  return history.some((m) =>
    (m.role === "tool" && typeof m.content === "string" && /Proposal #\d+ created|\[earlier proposal #\d+/.test(m.content))
    || (m.role === "assistant" && !!m.tool_calls?.some((c) => writeTools.has(c.function.name))));
}

/**
 * Sent back once when the model's first reply of a turn holds neither a tool
 * call nor words. The empty draft itself is not sent along: llm-service
 * refuses an assistant message without content or tool calls.
 */
export const EMPTY_REPLY_NUDGE = "Your reply was empty. Call the tool that answers the question now, or answer in plain words.";

/** Sent with the forced last round when its answer was a tool call written as text. */
export const FINAL_ANSWER_NUDGE = "No more tool calls are possible. Answer the user now in plain words, only from the tool results above; say what is missing if they were not enough.";

/** A tool call or a tool note written out as text — Gemma's own call syntax, or the shape of a history note. */
const FAKE_CALL_RE = /<\|?tool_call|<tool_call\|>|\[tools behind this answer|\[summary of an earlier turn|\bcall:[a-z_]+\{/i;

export function looksLikeFakeToolCall(text: string | null): boolean {
  return !!text && FAKE_CALL_RE.test(text);
}

/** Lines a model adds about the tools it used ("*Tools: list_categories*"); the app shows those itself. */
const TOOL_NOTE_LINE_RE = /^\s*[*_(]*\s*(?:tools?|werkzeuge?)\s*:\s*[a-z_]+(?:\s*,\s*[a-z_]+)*\s*[*_)]*\s*$/gim;

const NO_ROWS_RE = /\[\[\s*ohne\s+liste\s*\]\]/gi;

export function wantsNoRows(text: string | null): boolean {
  return !!text && new RegExp(NO_ROWS_RE.source, "i").test(text);
}

/** The note under a replayed summary (`summary.ts`), should the model copy it into an answer. */
const SUMMARY_NOTE_RE = /\[summary of an earlier turn[^\]]*\]/gi;

export function cleanAnswer(text: string): string {
  return text.replace(TOOL_NOTE_LINE_RE, "").replace(SUMMARY_NOTE_RE, "").replace(NO_ROWS_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

const AMOUNT_RE = /\d,\d{2}\s*(?:€|eur\b)|(?:€|eur)\s*-?\d|\d\.\d{2}\s*(?:€|eur\b)/i;
const DATE_RE = /\b\d{1,2}\.\s?\d{1,2}\.\s?(?:\d{4}|\d{2})\b|\b\d{4}-\d{2}-\d{2}\b/;
const LIST_LINE_RE = /^\s*(?:[-*•]|\d+[.)])\s+.*\d/;

/** Does an answer read like rows of the user's data (amounts, dates, a list with numbers)? */
export function looksLikeUserData(text: string | null): boolean {
  if (!text) return false;
  if (AMOUNT_RE.test(text) || DATE_RE.test(text)) return true;
  return text.split("\n").filter((line) => LIST_LINE_RE.test(line)).length >= 3;
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
  /** A fixed budget in estimated tokens, the answer included; overrides the window. */
  contextTokens?: number;
  /** The model's window in real tokens, when already known; a reply that names it updates it. */
  contextWindow?: number;
  /** Digests of the tool results in `history`, by call id: what they shrink to when room runs out. */
  historyDigests?: Record<string, string>;
  schemaBudgetTokens?: number;
  /**
   * The user's "Abbrechen". Checked before each model round and each tool
   * call, and handed to the model call; a cancelled turn throws the signal's
   * reason and emits nothing more.
   */
  signal?: AbortSignal;
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
  /**
   * The router's model stage (a short call bound to `choose_areas`) when the
   * cheap stages name no area. Off by default: a turn with no area named
   * then runs with every area, as before the router.
   */
  routeModel?: boolean;
  /**
   * The checker (stage 5): after an answer about the user's data, one short
   * call bound to `check_answer` holds it against the turn's tool results.
   * Off by default, so a scripted test sees only the rounds it scripted;
   * `ask` and the benchmark switch it on unless `ASSISTANT_VERIFY=0`.
   */
  verify?: boolean;
}

export interface TurnResult {
  answer: string;
  blocks: ResultBlock[];
  /** The turn's messages after the history: question, tool rounds, answer. */
  transcript: ChatMessage[];
  /** Per tool call id: its one-line digest and the set it found, for later turns. */
  toolResults: Record<string, { digest: string; ref?: ResultRef }>;
  rounds: number;
  /** How full the window got, for the line under the chat. */
  context: ContextUsage;
  /** The areas in play at the end of the turn, and how the first ones were decided. */
  areas: AreaId[];
  routing: RoutingStage;
  /** The plan of a multi-step question, with what got done (stage 3); absent when none was asked for or written. */
  plan?: PlanStep[];
  /**
   * What the plan call came back with, when one was made: the plan, a real
   * tool call (then used as round 1 instead of being thrown away), or nothing
   * usable.
   */
  planOutcome?: "plan" | "tool_call" | "none";
  /** The checker's work (stage 5); absent when no answer was checked. */
  checks?: TurnChecks;
  /** Replies llama-server could not parse and the loop asked for once more (llama.cpp issue #25072); absent when none. */
  malformedReplies?: number;
}

export interface TurnChecks {
  /** Check calls made this turn. */
  calls: number;
  /** Checks that found a claim the results do not hold. */
  failed: number;
  /** The area the checker sent the turn to, when it did. */
  wrongArea?: AreaId;
  /** What the answer went out with as unbacked, after the last allowed check failed. */
  unverified?: string;
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
    // A turn goes whole: a tool call never stays behind without the
    // question that led to it, nor a tool result without its call.
    while (bounds.questionIndex - removed > 1 && messages[1].role !== "user") {
      messages.splice(1, 1);
      removed++;
    }
  }
  return removed;
}

/** JSON with object keys sorted at every depth, so equal arguments compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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

/**
 * Block kinds where a later block in the same turn supersedes the earlier
 * ones whatever tool produced them: a document found by summary replaces the
 * search it came from, which replaced the tax listing before it. Lists of
 * other kinds (two accounts, two meters) stay side by side.
 */
const NARROWING_FAMILIES: Record<string, string> = { documents: "documents", document: "documents", photos: "photos" };

function narrowingFamily(kind: string): string | null {
  return NARROWING_FAMILIES[kind] ?? null;
}

/**
 * Sent back to the model for a result with no rows and no hint of its own:
 * a call with arguments may have asked too narrowly, a call without has
 * found that the user has none of these.
 */
export const EMPTY_RESULT_HINT = "No rows. Before you tell the user nothing exists, drop or widen one filter (the period, the text, the category) and call once more; if the question needs every filter, say that nothing matches and name the criteria.";

/** The result text with its hint, or with the loop's general hint when it found nothing and said nothing about it. */
export function withHint(outcome: ToolOutcome, args: Record<string, unknown>): string {
  if (outcome.hint) return `${outcome.text}\n\n${outcome.hint}`;
  const filtered = Object.values(args).some((v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length));
  if (outcome.rowCount === 0 && filtered) return `${outcome.text}\n\n${EMPTY_RESULT_HINT}`;
  return outcome.text;
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const now = input.now ?? new Date();
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const fixed = input.contextTokens ?? FIXED_CONTEXT_TOKENS;
  let window = input.contextWindow ?? null;
  const currentBudget = () => fixed !== null
    ? fixed - ANSWER_TOKENS
    : window !== null ? budgetForWindow(window) : FALLBACK_CONTEXT_TOKENS - ANSWER_TOKENS;
  const emit = input.emit ?? (() => {});
  const withSlot = input.withSlot ?? ((fn) => fn());
  const tools = input.tools.filter((t) => mayUse(t, input.user));
  const missingAreas = userAccess(input.user.permissions).missing.length > 0;

  // The router decides which areas the question needs; their tools are what
  // the model sees in round 1. Every other area is one switch_area away.
  const routing = await route({
    question: input.question,
    history: input.history,
    context: input.context?.refs,
    chat: input.routeModel ? input.chat : undefined,
    signal: input.signal,
    withSlot: input.withSlot,
  });
  const active = new Set<AreaId>(routing.areas);
  /** The tools of the areas in play that the user may use. */
  const inPlay = (): ToolSpec[] => {
    const names = new Set<string>();
    for (const id of active) for (const name of toolsOfArea(areaById(id)!)) names.add(name);
    return tools.filter((t) => names.has(t.name));
  };
  const firstTools = inPlay();
  const deferred = estimateTokens(firstTools.map(toolDefinition)) > (input.schemaBudgetTokens ?? DEFAULT_SCHEMA_BUDGET);
  const offered = new Map<string, ToolSpec>(deferred ? [] : firstTools.map((t) => [t.name, t]));
  /** Areas with a tool for this user that are not in play yet. */
  const switchable = (): AreaId[] => AREA_IDS.filter((id) => !active.has(id) && tools.some((t) => toolsOfArea(areaById(id)!).includes(t.name)));
  const activate = (id: AreaId): void => {
    active.add(id);
    if (!deferred) for (const t of inPlay()) offered.set(t.name, t);
  };

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt(firstTools, now, deferred, input.context?.briefs, input.user.permissions, routing.areas, switchable()),
    },
    ...input.history,
    { role: "user", content: input.question },
  ];
  let questionIndex = messages.length - 1;
  let lastRoundStart = questionIndex;
  // Earlier turns' results go along whole; these are what they shrink to.
  const digests = new Map<string, string>(Object.entries(input.historyDigests ?? {}));
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

  let noRows = false;
  let rounds = 0;
  let calledTools = false;
  /** Calls already made in this turn, by tool and arguments: a repeat is answered from above. */
  const seenCalls = new Set<string>();
  /** The ungrounded answer and the nudge, sent along until the model calls a tool or answers again. */
  let nudge: ChatMessage[] | null = null;
  /** One more request for words after an empty reply; never twice. */
  let emptyRetried = false;
  /**
   * The pending nudge is the one for an empty reply. The words that follow
   * it are a first draft like any other, so the checks below still apply to
   * them (the benchmark saw "ich konnte keine Dokumente finden" go out
   * without a tool call after an empty round).
   */
  let afterEmptyReply = false;
  /** One push from "bitte bestätigen" in words to the card; never twice. */
  let consentNudged = false;
  const mayPropose = tools.some((t) => t.kind === "write");
  let revisionNudged = false;
  /** The checker's tally (stage 5); `null` until an answer was checked. */
  let checks: TurnChecks | null = null;
  /** The checker sends a turn to another area at most once. */
  let rerouted = false;
  /** Meta tools whose results hold no data the check could hold an answer against. */
  const metaTools = new Set([WRITE_PLAN_NAME, DESCRIBE_TOOLS_NAME, SWITCH_AREA_NAME]);

  const historyTurns = input.history.filter((m) => m.role === "user").length;
  const usage: ContextUsage = {
    used: null, window, estimated: 0, budget: currentBudget(), historyTurns, keptTurns: historyTurns, digested: 0,
  };
  /** Replies llama-server could not parse, each sent once more. */
  let malformedReplies = 0;
  /** One /chat call, and what it took of the window. */
  const send = async (request: ChatRequest): Promise<ChatReply> => {
    let reply: ChatReply;
    try {
      reply = await withSlot(() => input.chat(request, (text) => emit({ type: "token", text }), input.signal));
    } catch (err) {
      // The model wrote a call llama-server's parser did not read. For a
      // call bound by grammar that is the grammar's doing (llama.cpp issues
      // #29089 and #30256: on Gemma 4 it leaves the tail of the call
      // unconstrained, and the same prompt fails every time), so the call
      // goes once more as the one tool without the grammar — the model
      // then calls it by prompt, as the checker and the router did before
      // the grammar. An ordinary round's reply is sampled, and the sporadic
      // fault of the parser (issue #25072) seldom strikes twice: the same
      // request goes again.
      if (!(err instanceof MalformedReplyError)) throw err;
      input.signal?.throwIfAborted();
      malformedReplies++;
      emit({ type: "retract" });
      const retry = unbound(request);
      try {
        reply = await withSlot(() => input.chat(retry, (text) => emit({ type: "token", text }), input.signal));
      } catch (again) {
        if (again instanceof MalformedReplyError) again.repeated = malformedReplies;
        throw again;
      }
    }
    const estimated = estimateTokens(request.messages) + estimateTokens(request.tools ?? []);
    usage.estimated = Math.max(usage.estimated, estimated);
    const counted = reply.usage;
    if (counted?.n_ctx) window = usage.window = counted.n_ctx;
    if (counted?.prompt_tokens != null) {
      usage.used = Math.max(usage.used ?? 0, counted.prompt_tokens + (counted.completion_tokens ?? 0));
      calibrateEstimate(estimated, counted.prompt_tokens);
    }
    usage.budget = currentBudget();
    const sent = request.messages;
    usage.keptTurns = Math.min(usage.keptTurns, sent.slice(1, questionIndex).filter((m) => m.role === "user").length);
    usage.digested = Math.max(usage.digested, sent.slice(1).filter(
      (m) => m.role === "tool" && digests.get(m.tool_call_id) === m.content,
    ).length);
    return reply;
  };
  /** The tools of a round: the meta tools, the plan tool once a plan exists, and what is offered. */
  const roundDefinitions = (withPlan = plan !== null): unknown[] => {
    // describe_tools stands in for every schema not sent along: those of a
    // deferred catalog, and those of the areas not in play.
    const describable = deferred || offered.size < tools.length;
    return [
      ...(describable ? [describeToolsDefinition] : []),
      ...(switchable().length ? [switchAreaDefinition] : []),
      ...(withPlan ? [planDefinition] : []),
      ...[...offered.values()].map(toolDefinition),
    ];
  };
  /** Shrinks the conversation to the budget before a request with these definitions. */
  const fit = (definitions: unknown[], protectFrom = lastRoundStart, factor = 1): void => {
    const shift = fitContext(messages, digests, Math.floor(currentBudget() * factor), { protectFrom, questionIndex }, estimateTokens(definitions));
    questionIndex -= shift;
    lastRoundStart -= shift;
  };

  // The plan of a multi-step question (stage 3 of assistent-wegfindung.md):
  // one call bound to write_plan before the first tool, with the tools of
  // round 1 alongside so the steps name roads that exist. The plan enters
  // the transcript as a tool round of its own, and its status after every
  // result says which step comes next. The plan tool stays in the catalog
  // for the rest of the turn, so the tool list — and with it the cached
  // prompt prefix — is the same in every round.
  let plan: PlanStep[] | null = null;
  let planRounds = 0;
  let planNudged = false;
  let planOutcome: TurnResult["planOutcome"];
  /** The plan call's reply when it was a real tool call: round 1 runs it instead of asking again. */
  let carried: ChatReply | null = null;
  const planNames = firstTools.map((t) => t.name);
  const planDefinition = writePlanDefinition(planNames);
  if (routing.needsPlan && planNames.length >= 2 && maxRounds > 2) {
    input.signal?.throwIfAborted();
    const definitions = roundDefinitions(true);
    fit(definitions);
    try {
      const reply = await send({
        messages: [...messages],
        tools: definitions,
        tool_choice: { type: "function", function: { name: WRITE_PLAN_NAME } } satisfies ForcedTool,
        max_tokens: PLAN_TOKENS,
        ...(PLAN_THINKING ? { thinking: true } : {}),
      });
      planRounds = 1;
      plan = parsePlan(reply, new Set(planNames));
      const call = reply.tool_calls.find((c) => c.function.name === WRITE_PLAN_NAME);
      planOutcome = plan && call ? "plan" : "none";
      if (!(plan && call) && reply.tool_calls.some((c) => c.function.name !== WRITE_PLAN_NAME)) {
        // The model went straight for a tool: that reply is round 1, not
        // waste. The plan call then counts as that round.
        planOutcome = "tool_call";
        carried = { ...reply, tool_calls: reply.tool_calls.filter((c) => c.function.name !== WRITE_PLAN_NAME) };
        planRounds = 0;
      }
      if (plan && call) {
        lastRoundStart = messages.length;
        messages.push({ role: "assistant", content: null, tool_calls: [call] });
        messages.push({ role: "tool", tool_call_id: call.id, content: planText(plan) });
        // What the plan shrinks to in a later turn's history.
        const digest = `[plan of this turn: ${plan.map((s) => s.tool).join(" → ")}]`;
        digests.set(call.id, digest);
        toolResults[call.id] = { digest };
      } else {
        plan = null;
      }
    } catch (err) {
      // No room for the plan: the loop runs without one and shrinks on its own.
      if (!(err instanceof ContextTooLargeError)) throw err;
    }
  }

  for (let round = 1; round <= maxRounds && answer === null; round++) {
    input.signal?.throwIfAborted();
    rounds = planRounds + round;
    const last = round === maxRounds;
    const definitions = roundDefinitions();
    // The previous round's results stay whole; older ones may shrink.
    fit(definitions);

    const request = {
      messages: [...messages, ...(nudge ?? [])],
      tools: definitions.length ? definitions : undefined,
      tool_choice: definitions.length ? (last ? "none" as const : "auto" as const) : undefined,
      max_tokens: ANSWER_TOKENS,
    };
    let reply: ChatReply;
    if (carried) {
      reply = carried;
      carried = null;
    } else {
      try {
        reply = await send(request);
      } catch (err) {
        if (!(err instanceof ContextTooLargeError)) throw err;
        // The estimate was optimistic. Shrink everything that can shrink and
        // try this round once more.
        fit(definitions, messages.length, 0.6);
        request.messages = [...messages, ...(nudge ?? [])];
        reply = await send(request);
      }
    }

    // Neither a call nor words before any tool ran: asked once more, with
    // the tools still offered. The regex checks below would otherwise send
    // the empty draft along as an assistant message without content, which
    // llm-service refuses. After a tool ran, the words-only retry below
    // handles an empty reply.
    const emptyReply = !reply.tool_calls.length && !(reply.content ?? "").trim();
    if (emptyReply && !calledTools && !last && !emptyRetried) {
      emptyRetried = true;
      afterEmptyReply = true;
      nudge = [{ role: "user", content: EMPTY_REPLY_NUDGE }];
      continue;
    }

    const fakeCall = !reply.tool_calls.length && looksLikeFakeToolCall(reply.content);
    // "Für Finanzen fehlt dir die Berechtigung" is the right answer without
    // a tool when the area is missing; pushing for a tool there would push
    // for one the catalog does not hold.
    const dataQuestion = !reply.tool_calls.length && !calledTools && isDataQuestion(input.question)
      && !(missingAreas && saysPermissionMissing(reply.content));
    const ungrounded = !reply.tool_calls.length && !calledTools && looksLikeUserData(reply.content);
    // A request for confirmation in words leaves the user nothing to press:
    // only a write tool makes the card. Once a card exists, "wartet auf
    // deine Bestätigung" is the right answer.
    const asksConsent = !reply.tool_calls.length && !consentNudged && mayPropose
      && !blocks.some((b) => b.kind === "proposal") && asksForConsent(reply.content);
    // "Ich habe die Collage angepasst" after a correction, with no new card
    // behind it: the card the user sees is the old one above their question.
    const claimsRevision = !reply.tool_calls.length && !revisionNudged && mayPropose
      && !blocks.some((b) => b.kind === "proposal") && claimsChange(reply.content)
      && proposedEarlier(messages.slice(0, questionIndex), new Set(tools.filter((t) => t.kind === "write").map((t) => t.name)));
    // An answer with planned steps still open: the plan was the model's
    // own, so it is sent back to it once.
    const planOpen = !reply.tool_calls.length && plan !== null && !planNudged && plan.some((s) => !s.done)
      && !(missingAreas && saysPermissionMissing(reply.content));
    if (!last && (nudge === null || afterEmptyReply) && !emptyReply && (fakeCall || dataQuestion || ungrounded || asksConsent || claimsRevision || planOpen)) {
      // Not kept in the transcript: the draft was never the answer.
      const text = fakeCall ? FAKE_CALL_NUDGE : ungrounded ? GROUNDING_NUDGE : asksConsent ? CONSENT_NUDGE
        : claimsRevision ? REVISION_NUDGE : planOpen ? planNudge(plan!) : DATA_QUESTION_NUDGE;
      if (text === CONSENT_NUDGE) consentNudged = true;
      if (text === REVISION_NUDGE) revisionNudged = true;
      if (planOpen && !fakeCall && !ungrounded && !asksConsent && !claimsRevision) planNudged = true;
      nudge = [{ role: "assistant", content: reply.content }, { role: "user", content: text }];
      afterEmptyReply = false;
      emit({ type: "retract" });
      continue;
    }
    if (last && fakeCall) {
      // The forced last round wrote a call instead of an answer: ask once
      // more, without tools, for the answer in words.
      emit({ type: "retract" });
      const retry = await send({
        messages: [...messages, { role: "assistant", content: reply.content }, { role: "user", content: FINAL_ANSWER_NUDGE }],
        max_tokens: ANSWER_TOKENS,
      });
      rounds++;
      emptyRetried = true;
      reply = { ...retry, tool_calls: [] };
      if (looksLikeFakeToolCall(reply.content)) reply = { ...reply, content: null };
    }
    if (reply.tool_calls.length) {
      calledTools = true;
      nudge = null;
      afterEmptyReply = false;
    }
    if (!reply.tool_calls.length || last) {
      noRows = wantsNoRows(reply.content);
      answer = cleanAnswer(reply.content ?? "");
      if (!answer && !emptyRetried && !looksLikeFakeToolCall(reply.content ?? "")) {
        // Nothing at all after the tool results (the benchmark saw Gemma end
        // a Lastschriften turn this way): ask once more, without tools, for
        // the answer in words before giving up on the turn.
        emptyRetried = true;
        const retry = await send({
          messages: [...messages, { role: "user", content: FINAL_ANSWER_NUDGE }],
          max_tokens: ANSWER_TOKENS,
        });
        rounds++;
        noRows = wantsNoRows(retry.content);
        answer = cleanAnswer(retry.content ?? "");
      }
      if (!answer || looksLikeFakeToolCall(answer)) {
        answer = last ? OUT_OF_ROUNDS : NO_ANSWER;
        break;
      }
      // The checker (stage 5 of assistent-wegfindung.md): an answer about the
      // user's data that passed the regex checks above is held against the
      // turn's tool results by one short bound call. A claim they do not hold
      // goes back to the model once; a question answered from the wrong
      // area's tools gets that area and goes back once; after the last
      // allowed failed check the answer goes out with a note instead.
      const checkable = input.verify && !last && !emptyRetried
        && (calledTools || isDataQuestion(input.question))
        && !(missingAreas && saysPermissionMissing(answer))
        && (checks?.failed ?? 0) < MAX_FAILED_CHECKS;
      if (checkable) {
        input.signal?.throwIfAborted();
        const request = checkRequest({
          question: input.question,
          results: turnResults(messages.slice(questionIndex + 1), metaTools),
          answer,
          areas: AREAS.map((a) => ({
            id: a.id, description: a.description, inPlay: active.has(a.id),
            tools: tools.filter((t) => toolsOfArea(a).includes(t.name)).map((t) => t.name),
          })),
        });
        let verdict: Verdict | null = null;
        try {
          verdict = parseVerdict(await withSlot(() => input.chat(request, undefined, input.signal)));
        } catch (err) {
          // A check that cannot run never costs the answer; a cancelled turn does.
          if (input.signal?.aborted) throw err;
          verdict = null;
        }
        checks = checks ?? { calls: 0, failed: 0 };
        checks.calls++;
        if (verdict && !verdict.grounded) {
          checks.failed++;
          if (checks.failed >= MAX_FAILED_CHECKS) {
            checks.unverified = verdict.missing;
            answer = `${answer}\n\n${unverifiedNote(verdict.missing)}`;
          } else {
            nudge = [{ role: "assistant", content: reply.content }, { role: "user", content: ungroundedNudge(verdict.missing) }];
            emit({ type: "retract" });
            answer = null;
            continue;
          }
        } else if (verdict?.wrongArea && !rerouted && !active.has(verdict.wrongArea) && switchable().includes(verdict.wrongArea)) {
          const area = areaById(verdict.wrongArea)!;
          rerouted = true;
          checks.wrongArea = area.id;
          activate(area.id);
          if (deferred) for (const t of tools) if (toolsOfArea(area).includes(t.name)) offered.set(t.name, t);
          nudge = [{ role: "assistant", content: reply.content }, { role: "user", content: wrongAreaNudge(area.id, areaPackage(area, tools)) }];
          emit({ type: "retract" });
          answer = null;
          continue;
        }
      }
      break;
    }

    lastRoundStart = messages.length;
    messages.push({ role: "assistant", content: reply.content, tool_calls: reply.tool_calls });
    /** The tools that ran this round without an error, for the plan. */
    const ranOk: string[] = [];
    for (const call of reply.tool_calls) {
      input.signal?.throwIfAborted();
      const name = call.function.name;
      const args = parseArguments(call.function.arguments);
      const result = (content: string) => messages.push({ role: "tool", tool_call_id: call.id, content });

      if (args === null) {
        result(`error: the arguments of ${name} are not a JSON object`);
        continue;
      }
      if (name === DESCRIBE_TOOLS_NAME) {
        const { text, described } = describeTools(args.names, tools);
        // A described tool of an area not in play brings its area's rules along.
        const added: string[] = [];
        for (const t of described) {
          const home = homeOf(t.name);
          if (home && !active.has(home)) {
            activate(home);
            const rules = areaRulesSection(areaById(home)!);
            if (rules) added.push(rules);
          }
          offered.set(t.name, t);
        }
        result([text, ...added].join("\n\n"));
        continue;
      }
      if (name === WRITE_PLAN_NAME && plan) {
        result(`The plan is written; follow it.\n${planText(plan)}`);
        continue;
      }
      if (name === SWITCH_AREA_NAME) {
        const area = areaById(String(args.area ?? ""));
        if (!area) {
          result(`error: unknown area; one of ${AREA_IDS.join(", ")}`);
        } else {
          const wasActive = active.has(area.id);
          activate(area.id);
          result(wasActive ? `${area.id} is already in play; its tools are offered.` : areaPackage(area, tools));
          if (deferred) for (const t of tools) if (toolsOfArea(area).includes(t.name)) offered.set(t.name, t);
        }
        continue;
      }
      const key = `${name}:${canonical(args)}`;
      if (seenCalls.has(key)) {
        result(`error: you already called ${name} with these arguments in this turn; its result is above. Use it, change the arguments, or answer.`);
        continue;
      }
      const tool = tools.find((t) => t.name === name);
      if (!tool || (deferred && !offered.has(name))) {
        result(tool
          ? `error: call ${DESCRIBE_TOOLS_NAME} for ${name} first`
          : `error: ${name} is not in the catalog`);
        continue;
      }
      // A tool of an area not in play, called by name: the model knew the
      // road, so the area joins the turn and the call runs.
      if (!offered.has(name)) {
        const home = homeOf(name);
        if (home) activate(home);
        offered.set(name, tool);
      }
      // The arguments against the schema, before anything runs: a value the
      // tool would have swallowed becomes an error that names it (stage 2 of
      // assistent-wegfindung.md). A refused call may come again, corrected.
      const problems = checkArguments(tool, args);
      if (problems.length) {
        const message = problems.join("; ");
        result(argumentError(name, problems));
        emit({ type: "tool_result", tool: name, rowCount: 0, error: message });
        input.log?.({ tool: name, arguments: args, rows: 0, ms: 0, error: message });
        continue;
      }
      // Only a call that runs counts; a refused one may come again.
      seenCalls.add(key);

      emit({ type: "tool_start", tool: name, arguments: args });
      const started = Date.now();
      try {
        const outcome = await tool.run(args, ctx);
        digests.set(call.id, outcome.digest);
        toolResults[call.id] = { digest: outcome.digest, ref: outcome.ref };
        if (outcome.ref) refs.set(outcome.ref.type, outcome.ref.ids);
        if (outcome.block) {
          // A repeated search replaces its earlier block: the model searched
          // again because the first rows did not fit, and showing both put
          // a table of near misses above the one the answer is about.
          if (tool.refines) {
            for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]!.tool === name) blocks.splice(i, 1);
          }
          // The same across tools for the kinds the model narrows down: the
          // tax documents, then a search, then the three it read are one
          // trail to one list, not three lists. The steps line keeps the
          // trail; the answer carries the list it is about.
          const family = narrowingFamily(outcome.block.kind);
          if (family) {
            for (let i = blocks.length - 1; i >= 0; i--) if (narrowingFamily(blocks[i]!.kind) === family) blocks.splice(i, 1);
          }
          blocks.push(outcome.block);
        }
        result(withHint(outcome, args));
        ranOk.push(name);
        emit({ type: "tool_result", tool: name, rowCount: outcome.rowCount, block: outcome.block });
        input.log?.({ tool: name, arguments: args, rows: outcome.rowCount, ms: Date.now() - started });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A refusal is not an empty result: the model passes it on as such.
        const denied = (err as { code?: unknown } | null)?.code === "permission_denied";
        result(denied
          ? `error: ${name} failed: no access (permission_denied): ${message}`
          : `error: ${name} failed: ${message}. Fix what it names and call again, or use another tool; do not repeat the same call.`);
        emit({ type: "tool_result", tool: name, rowCount: 0, error: message });
        input.log?.({ tool: name, arguments: args, rows: 0, ms: Date.now() - started, error: message });
      }
    }
    if (plan) {
      // Tick off the steps whose tool ran, and tell the model what is next
      // at the end of this round's last result — appended, so the earlier
      // messages and the cached prefix stay as they were.
      for (const name of ranOk) {
        const step = plan.find((s) => !s.done && s.tool === name);
        if (step) step.done = true;
      }
      const tail = messages[messages.length - 1]!;
      if (tail.role === "tool") messages[messages.length - 1] = { ...tail, content: `${tail.content}\n\n${planStatus(plan)}` };
    }
  }

  const final = answer ?? OUT_OF_ROUNDS;
  messages.push({ role: "assistant", content: final });
  const transcript = messages.slice(questionIndex);
  // The model said the rows do not answer the question: the answer stands
  // alone. A proposal card stays — it is the user's button, not a result.
  if (noRows) {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]!.kind !== "proposal") blocks.splice(i, 1);
  }
  emit({ type: "done", answer: final, blocks });
  return {
    answer: final, blocks, transcript, rounds, toolResults, context: usage,
    areas: AREA_IDS.filter((id) => active.has(id)), routing: routing.stage,
    ...(plan ? { plan } : {}),
    ...(planOutcome ? { planOutcome } : {}),
    ...(checks ? { checks } : {}),
    ...(malformedReplies ? { malformedReplies } : {}),
  };
}
