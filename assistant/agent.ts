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
import { ContextTooLargeError, type ChatFn, type ChatReply, type ChatRequest } from "./llm-client";
import type {
  AssistantUser,
  ChatMessage,
  ContextUsage,
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
 * The full catalog of a user with every module is about 6100 tokens (38
 * tools, the depot and tax tools included); the budget leaves room for a
 * few more before a round goes to fetching. A deployment with a small
 * context window lowers it through the environment — and raises
 * ASSISTANT_CONTEXT_TOKENS along with the model's window, since the
 * schemas count against that budget on every round.
 */
const DEFAULT_SCHEMA_BUDGET = Number.parseInt(process.env.ASSISTANT_SCHEMA_BUDGET_TOKENS ?? "8000", 10);

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

const RULES = `You are the assistant of a private household server that keeps finance bookings, documents, photos, utility meters and trip plans. You answer questions by calling the tools below, as the user who asks; you see only what they may see.

You know nothing about this user's data. Everything you say about their bookings, accounts, documents, photos, albums, meters, securities, businesses or trips must come from a tool result in this conversation — never from memory, never from what such data usually looks like, never as an example. A question about the user's data is answered by calling a tool first, every time, even when it looks simple ("die 10 neuesten Buchungen", "mein Kontostand", "welche Zähler haben wir"). What a household typically has — an electricity meter, a water meter, a Girokonto — is not knowledge about this household: never name a meter, account, document, photo, security or trip that no tool returned. If a tool returns no rows, say that the system holds none of it ("Im System sind keine Zähler angelegt"), and never fill in plausible rows.

Rules:
- Use tools for every fact. Never invent data, ids, names, dates or amounts a tool did not return.
- Never do arithmetic yourself. Sums, counts and periods come from tools (transaction_totals, upcoming_payments, consumption_report print them). If no tool computed a number, do not state it.
- Dates in tool arguments are ISO (YYYY-MM-DD); use the periods resolved below.
- Combine tools from different areas when the question needs it.
- The rows a tool returned are shown to the user beside your answer, so summarise rather than repeat every row; name what fits the question and what does not.
- If the rows you found do not answer the question — a search for flights that returned only coffee bills, a listing with nothing that matches — say so and end your answer with the line ${NO_ROWS_MARKER} on its own; the app then leaves the rows out. Use it only when none of the rows is what was asked for.
- If a tool finds nothing, say so plainly and suggest how to search differently.
- Earlier turns show the tool calls behind each answer and what they found. A follow-up on those rows ("davon", "nur die aus …", "mach daraus …") is a new tool call with from_previous_result: true, never an answer from memory. Only a real tool call does anything: never write tool calls, tool names or notes about tools into your answer — the app shows the tools itself.
- Businesses (Betriebe): a leased farm, a PV system or a trade is a business in the register with its fixed assets (Anlagegüter), their depreciation (AfA) and, for a farm, its parcels (Flurstücke) with lessee and rent. "Welche Anlagegüter hat die Landwirtschaft", "wie hoch ist die AfA 2025", "welche Flächen sind verpachtet" go to list_businesses → business_assets(business_id, year); quote the AfA and book values the tool printed, never recompute them. "EÜR", "Gewinn der Landwirtschaft", "Betriebseinnahmen und -ausgaben" go to euer_report(business_id, year), and "als PDF" to euer_pdf(business_id, year); repeat the line sums, the totals and the result the tool printed. "Ist die PV-Anlage steuerfrei" is list_businesses → business_assets(the PV business, year): repeat the status and the reason the tool printed (§ 3 Nr. 72 EStG, up to 30 kWp from 2022), never decide it yourself. "Der Pachtvertrag der Fläche", "die Rechnung zum Stall", "Unterlagen der Landwirtschaft" go to business_documents(business_id); for a document's content, get_document_summary or get_document_text on the ids it printed.
- Tax: documents carry a tax-relevant flag, a tax year and Anlagen (tax sections); bookings carry a tax-relevant flag. "Steuer 2025" questions go to tax_documents(year) and list_transactions(tax_relevant = true, from/to = that year); "alle Unterlagen für die Steuer 2025 in eine Mappe" is tax_return_bundle(year = 2025); "hilf mir beim Ausfüllen" is tax_worksheet(year), as PDF tax_worksheet_pdf(year). Never judge tax relevance yourself, and never compute a tax figure: repeat the sums the worksheet printed (bookings, businesses, depot, and the values by form field with their Zeile and Kennzahl). A document's figure exists only as a value by form field: state it with its line and Kennzahl and say when it is still unconfirmed; for anything not listed there, point to the document.
- When the user answers an offer you made ("Soll ich eines davon genauer ansehen?" → "ja"), act on the rows of your previous answer — their ids are in the earlier tool results — with get_document_summary(ids = …) or get_document_text; never search again for them.
- Tools of kind "write" never change anything: they create a proposal the user confirms with a button on a card. Call one only when the user asks for that change, then say what you proposed and that it waits for "Ausführen" on the card. Never claim it is done. Never ask for confirmation in words instead ("Soll ich …?", "Bitte bestätige …"): without the tool call there is no card and nothing the user could confirm — the card is the confirmation. If an earlier answer asked in words anyway and the user now says yes, call the write tool now.
- For a letter (Anschreiben, Antwort, Widerspruch, Kündigung …) call render_letter with the whole text: salutation, body and the closing formula ("Mit freundlichen Grüßen") — the server signs it with the user's name. Take every fact — names, dates, amounts, reference numbers — from the working set or a tool result, and put everything the user asks to have mentioned into the letter text itself, not only into your reply. Write dates in letters as DD.MM.YYYY. Before you leave the recipient's address or a customer, member or contract number open, look for it in the user's documents from that sender (search_documents, then get_document_text). Where the letter still needs a fact you do not have, write a gap that names it in double brackets, e.g. [[Mitgliedsnummer]], instead of guessing. The card cannot run while a gap is left, so when there are gaps, name them in plain words and say they have to be filled in on the card before "Ausführen" works; never write the bracket syntax itself into your reply.
- To keep something as a document ("speichere das als Dokument", "mach eine Notiz daraus", "fasse das Gespräch als Dokument zusammen") call create_text_document with a title and the complete text in Markdown, written from the tool results and answers of this conversation; never invent facts for it. A text document's Markdown is read back with get_document_text.
- When a table helps (a few rows compared by the same columns), write it as a Markdown table: a header row, then a separator row like |---|---:|, one row per line. The app shows it as a real table. Never draw tables with +---+, box characters or spaces, and never put a table in a code block.
- When you name a single item by its id, put its kind right before the number: "Dokument 123", "Buchung 4711", "Album 12", "Sammelmappe 5", "Zähler 3", "Betrieb 2", or "Dokument „Titel“ (ID 123)". The app turns such a mention into a link to the item's page. Only name ids a tool printed.
- Answer briefly in the user's language (usually German).`;

const EXAMPLES = `Examples of chained calls:
0. "Zeige mir die 10 neuesten Buchungen." → list_transactions(limit = 10) → name what the rows show; the rows themselves appear beside the answer.
1. "Welche Lastschriften muss ich diesen Monat noch erwarten?" → upcoming_payments(channel = "direct_debit", until = end of this month) → answer with the debits and the sum the tool printed; "was geht diesen Monat noch vom Konto ab" is the same call without channel (direct debits and transfers), never card payments or cash.
2. "Gib mir die Protokolle der Eigentümerversammlung der Wohnung in Musterstadt." → list_categories → search_documents(q = "Protokoll Eigentümerversammlung", category = the matching slug) → name the documents that fit.
3. "Wie viel Strom haben wir letztes Jahr verbraucht?" → list_meters → consumption_report(meter_id = the electricity meter, from/to = last year) → state the total the tool printed.
4. "Leg ein Album mit allen Favoriten von 2025 an." → create_album(name = "Favoriten 2025", photos = {favorite: true, date_from: "2025-01-01", date_to: "2025-12-31"}) → say the album is proposed with the count the tool printed and waits for "Ausführen".
5. After an answer listing photos: "Nur die aus München, und mach daraus ein Album." → list_photos(from_previous_result = true, place = "München") → create_album(name = …, from_previous_result = true) → say what was proposed.
6. After an answer listing documents of a purchase: "Schwärze den Kaufpreis und mach ein PDF daraus." → find the price first if it is not known (get_document_summary of the contract) → create_collection(name = …, from_previous_result = true, redact = [the price as printed, e.g. "450.000,00"]) → say how many pages get blacked out, name documents without word positions, and that the boxes should be checked in the Sammelmappe before passing the PDF on.
7. "Liste alle Buchungen zur Wohnung mit Zwischensummen für Kauf, Reparatur und Mieteinnahmen und ermittle die Rendite." → list_transactions (as needed) → transaction_report(title = …, groups = [{name: "Kauf", transaction_ids: […]}, {name: "Reparatur", …}, {name: "Mieteinnahmen", tag: "Miete"}], transaction_ids = all bookings found, yield = {investment_group: "Kauf", income_groups: ["Mieteinnahmen"], cost_groups: ["Reparatur"]}) → repeat only the subtotals and the yield formula the tool printed, and name bookings whose group was doubtful.
8. Working set of three invoices: "Schreib dem Absender, dass ich die drei Rechnungen bezahlt habe." → render_letter(recipient = the sender's address if a tool showed it, else [[Anschrift des Absenders]], subject = "Ihre Rechnungen …" with their numbers, body = salutation, one line per invoice with number, date and amount from the working set, [[Zahlungsdatum]] where the date of payment is unknown, closing) → say the letter waits on the card and name the gaps to fill.
9. "Wie steht mein Depot, und was hat Beispiel AG dieses Jahr an Dividende gebracht?" → portfolio_overview → depot_transactions(position = the key the overview printed, kind = "dividend", from/to = this year) → repeat the figures the tools printed (never add them up yourself); for the price today, quotes(q = the name); for news, position_news(key).
10. "Füge den Buchungen vom Baumarkt im September den Tag Renovierung hinzu." → list_transactions(q = "Baumarkt", from/to = September) → tag_transactions(from_previous_result = true, add = ["Renovierung"]) → say how many bookings get the tag and that it waits for "Ausführen" on the card; never ask first whether you should.`;

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
export const DATA_QUESTION_NUDGE = "The question is about the user's data in this system, but you called no tool in this turn. You do not know this user's data, and what such data usually looks like does not apply here. Call the tool that lists or reads it now (list_meters, list_accounts, search_documents, list_photos, portfolio_overview, list_businesses, list_trip_plans …). If no tool covers the question, say that the system holds no such data; if you need the user to choose first, ask that again unchanged. Never name items from memory.";

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

/** Sent with the forced last round when its answer was a tool call written as text. */
export const FINAL_ANSWER_NUDGE = "No more tool calls are possible. Answer the user now in plain words, only from the tool results above; say what is missing if they were not enough.";

/** A tool call or a tool note written out as text — Gemma's own call syntax, or the shape of a history note. */
const FAKE_CALL_RE = /<\|?tool_call|<tool_call\|>|\[tools behind this answer|\bcall:[a-z_]+\{/i;

export function looksLikeFakeToolCall(text: string | null): boolean {
  return !!text && FAKE_CALL_RE.test(text);
}

/** Lines a model adds about the tools it used ("*Tools: list_categories*"); the app shows those itself. */
const TOOL_NOTE_LINE_RE = /^\s*[*_(]*\s*(?:tools?|werkzeuge?)\s*:\s*[a-z_]+(?:\s*,\s*[a-z_]+)*\s*[*_)]*\s*$/gim;

const NO_ROWS_RE = /\[\[\s*ohne\s+liste\s*\]\]/gi;

export function wantsNoRows(text: string | null): boolean {
  return !!text && new RegExp(NO_ROWS_RE.source, "i").test(text);
}

export function cleanAnswer(text: string): string {
  return text.replace(TOOL_NOTE_LINE_RE, "").replace(NO_ROWS_RE, "").replace(/\n{3,}/g, "\n\n").trim();
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
  /** One push from "bitte bestätigen" in words to the card; never twice. */
  let consentNudged = false;
  const mayPropose = tools.some((t) => t.kind === "write");

  const historyTurns = input.history.filter((m) => m.role === "user").length;
  const usage: ContextUsage = {
    used: null, window, estimated: 0, budget: currentBudget(), historyTurns, keptTurns: historyTurns, digested: 0,
  };
  /** One /chat call, and what it took of the window. */
  const send = async (request: ChatRequest): Promise<ChatReply> => {
    const reply = await withSlot(() => input.chat(request, (text) => emit({ type: "token", text }), input.signal));
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
  for (let round = 1; round <= maxRounds && answer === null; round++) {
    input.signal?.throwIfAborted();
    rounds = round;
    const last = round === maxRounds;
    const definitions = [
      ...(deferred ? [describeToolsDefinition] : []),
      ...[...offered.values()].map(toolDefinition),
    ];
    // The previous round's results stay whole; older ones may shrink.
    const budget = currentBudget();
    const shift = fitContext(messages, digests, budget, { protectFrom: lastRoundStart, questionIndex }, estimateTokens(definitions));
    questionIndex -= shift;
    lastRoundStart -= shift;

    const request = {
      messages: [...messages, ...(nudge ?? [])],
      tools: definitions.length ? definitions : undefined,
      tool_choice: definitions.length ? (last ? "none" as const : "auto" as const) : undefined,
      max_tokens: ANSWER_TOKENS,
    };
    let reply: ChatReply;
    try {
      reply = await send(request);
    } catch (err) {
      if (!(err instanceof ContextTooLargeError)) throw err;
      // The estimate was optimistic. Shrink everything that can shrink and
      // try this round once more.
      const cut = fitContext(
        messages, digests, Math.floor(budget * 0.6), { protectFrom: messages.length, questionIndex }, estimateTokens(definitions),
      );
      questionIndex -= cut;
      lastRoundStart -= cut;
      request.messages = [...messages, ...(nudge ?? [])];
      reply = await send(request);
    }

    const fakeCall = !reply.tool_calls.length && looksLikeFakeToolCall(reply.content);
    const dataQuestion = !reply.tool_calls.length && !calledTools && isDataQuestion(input.question);
    const ungrounded = !reply.tool_calls.length && !calledTools && looksLikeUserData(reply.content);
    // A request for confirmation in words leaves the user nothing to press:
    // only a write tool makes the card. Once a card exists, "wartet auf
    // deine Bestätigung" is the right answer.
    const asksConsent = !reply.tool_calls.length && !consentNudged && mayPropose
      && !blocks.some((b) => b.kind === "proposal") && asksForConsent(reply.content);
    if (!last && nudge === null && (fakeCall || dataQuestion || ungrounded || asksConsent)) {
      // Not kept in the transcript: the draft was never the answer.
      const text = fakeCall ? FAKE_CALL_NUDGE : ungrounded ? GROUNDING_NUDGE : asksConsent ? CONSENT_NUDGE : DATA_QUESTION_NUDGE;
      if (text === CONSENT_NUDGE) consentNudged = true;
      nudge = [{ role: "assistant", content: reply.content }, { role: "user", content: text }];
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
      }
      break;
    }

    lastRoundStart = messages.length;
    messages.push({ role: "assistant", content: reply.content, tool_calls: reply.tool_calls });
    for (const call of reply.tool_calls) {
      input.signal?.throwIfAborted();
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
  // The model said the rows do not answer the question: the answer stands
  // alone. A proposal card stays — it is the user's button, not a result.
  if (noRows) {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]!.kind !== "proposal") blocks.splice(i, 1);
  }
  emit({ type: "done", answer: final, blocks });
  return { answer: final, blocks, transcript, rounds, toolResults, context: usage };
}
