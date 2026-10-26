/**
 * The router (documentation/plans/assistent-wegfindung.md, stage 1): which
 * areas a question needs, decided before the loop starts, so that the model
 * sees the rules and tools of those areas and not the other forty tools.
 *
 * Three stages, cheap to expensive, each used only when the one before
 * found nothing:
 *
 *   1. keywords — the words of each area (`Area.keywords`) in the question;
 *      the areas of the previous turn's tools are added when the question
 *      reads as a follow-up ("davon", "mach daraus", "ja"), and the areas of
 *      the working set when the question names none.
 *   2. the previous turn alone — a question with no keyword inherits the
 *      areas of the last turn's tools: the next question in a conversation
 *      usually stays on its subject, and when it does not, switch_area is
 *      one call away.
 *   3. a model call bound to one tool, `choose_areas`, with the area list and
 *      the question: a few hundred prompt tokens and a handful of output
 *      tokens, a fraction of a loop round.
 *
 * The routing also says whether the question needs a plan (stage 3): two
 * areas in play, chain words in the question ("und dann", "und mach
 * daraus"), or the model's own `needs_plan`. The loop then asks for the
 * steps before the first tool.
 *
 * When nothing decides, every area is in play — today's state, and the safe
 * one. An embedding stage (the question against the area descriptions,
 * through the E5 embedder of the embedding service) is planned between 1
 * and 3 and not built yet; the model stage covers its cases for now.
 */

import { AREAS, AREA_IDS, areasOfTools, isAreaId, type AreaId } from "./areas/index";
import { toolDefinition } from "./catalog";
import type { ChatFn, ChatRequest } from "./llm-client";
import type { ChatMessage, RefType } from "./types";

/** How the areas of a turn were decided. */
export type RoutingStage = "keywords" | "inherited" | "model" | "all";

export interface Routing {
  areas: AreaId[];
  stage: RoutingStage;
  /**
   * The question needs steps that build on each other (stage 3): two areas,
   * or words that chain one thing to the next. The loop then asks for a
   * plan before the first tool.
   */
  needsPlan: boolean;
}

/** More areas than this by keywords means the question is broad: everything stays in play. */
export const MAX_KEYWORD_AREAS = 3;

const KEYWORD_RES = new Map<AreaId, RegExp>(
  AREAS.map((a) => [a.id, new RegExp(`(?<!\\p{L})(?:${a.keywords})`, "iu")]),
);

/** The areas whose words the question uses, in catalog order. */
export function areasByKeywords(question: string): AreaId[] {
  return AREA_IDS.filter((id) => KEYWORD_RES.get(id)!.test(question));
}

/**
 * A question that leans on the previous answer: a pronoun for its rows, a
 * yes or no, an instruction without an object of its own.
 */
const FOLLOW_UP_RE = /(?<!\p{L})(?:davon|daraus|darin|darauf|dazu|damit|denen|diese[nmrs]?|dieses|jene|nur die|auch die|die (?:ersten|letzten|anderen)|ja|nein|genau|okay|ok|weiter|noch ?mal|und (?:jetzt|dann|nun))(?!\p{L})/iu;

export function looksLikeFollowUp(question: string): boolean {
  const words = question.trim().split(/\s+/).filter(Boolean).length;
  return words <= 4 || FOLLOW_UP_RE.test(question);
}

/** The areas of the tools the previous turn called. */
export function areasOfLastTurn(history: ChatMessage[]): AreaId[] {
  let start = history.length - 1;
  while (start >= 0 && history[start]!.role !== "user") start--;
  if (start < 0) return [];
  const names: string[] = [];
  for (const m of history.slice(start)) {
    if (m.role === "assistant") for (const c of m.tool_calls ?? []) names.push(c.function.name);
  }
  return areasOfTools(names);
}

const REF_AREAS: Record<RefType, AreaId> = { photo: "photos", document: "documents", transaction: "finance" };

/** The areas of a working set: what the user handed over is what they ask about. */
export function areasOfContext(refs: Array<{ type: RefType }>): AreaId[] {
  const hit = new Set(refs.map((r) => REF_AREAS[r.type]));
  return AREA_IDS.filter((id) => hit.has(id));
}

/**
 * Words that chain one step to the next: "und dann", "danach", "und mach
 * daraus", "erst … dann", "und füge … hinzu". A question with one of them
 * wants two things done in order, whatever area they are in.
 */
const CHAIN_RE = new RegExp(
  "(?<!\\p{L})(?:(?:und dann|danach|anschließend|und daraus|daraus dann|zuerst|zunächst)(?!\\p{L})|erst(?:mal)?(?!\\p{L})[^.?!]{0,60}(?<!\\p{L})(?:dann|danach)(?!\\p{L})"
  + "|und (?:leg|lege|erstell|erstelle|mach|mache|schreib|schreibe|schick|schicke|exportier|exportiere|speicher|speichere|vergleich|vergleiche|füg|füge|pack|packe|ordne|häng|hänge)(?!\\p{L})"
  + "|and then|afterwards|then (?:create|make|write|put|add|save|compare)(?!\\p{L}))",
  "iu",
);

/** Does the question chain one step to another in words? */
export function hasChainWords(question: string): boolean {
  return CHAIN_RE.test(question);
}

/** Two areas, or a chain in words: the question is one for a plan. */
function needsPlan(question: string, areas: AreaId[], stage: RoutingStage): boolean {
  return (stage !== "all" && areas.length >= 2) || hasChainWords(question);
}

function union(...lists: AreaId[][]): AreaId[] {
  const hit = new Set(lists.flat());
  return AREA_IDS.filter((id) => hit.has(id));
}

export const CHOOSE_AREAS_NAME = "choose_areas";

const chooseAreasDefinition = toolDefinition({
  name: CHOOSE_AREAS_NAME,
  summary: "The areas of the household server the question needs; none for small talk or a question about no stored data.",
  parameters: {
    type: "object",
    properties: {
      areas: { type: "array", items: { type: "string", enum: AREA_IDS }, description: "one or two area ids, the most likely first" },
      needs_plan: { type: "boolean", description: "true when the question needs two or more steps that build on each other" },
    },
    required: ["areas"],
  },
});

/** The short prompt of the model stage. */
export function routerPrompt(question: string): ChatMessage[] {
  const list = AREAS.map((a) => `- ${a.id}: ${a.description}`).join("\n");
  return [
    {
      role: "system",
      content: `You route questions to the areas of a private household server. Areas:\n${list}\n\nCall ${CHOOSE_AREAS_NAME} with the one or two areas the question needs — the data it asks about, or the thing it wants made. A follow-up on an earlier answer belongs to the area of that answer. Choose no area for greetings, thanks and questions about nothing the server keeps.`,
    },
    { role: "user", content: question },
  ];
}

/** The request of the model stage, exported so the benchmark can tell it from a loop round. */
export function routerRequest(question: string): ChatRequest {
  return { messages: routerPrompt(question), tools: [chooseAreasDefinition], tool_choice: "required", max_tokens: 64 };
}

export function isRouterRequest(req: ChatRequest): boolean {
  return req.tools?.length === 1
    && (req.tools[0] as { function?: { name?: string } }).function?.name === CHOOSE_AREAS_NAME;
}

/** What the model chose; null when it chose nothing usable. */
export function parseAreaChoice(reply: { tool_calls: Array<{ function: { name: string; arguments: string } }> }): AreaId[] | null {
  return parseChoice(reply)?.areas ?? null;
}

/** The model's choice with its plan flag; null when it chose nothing usable. */
export function parseChoice(reply: { tool_calls: Array<{ function: { name: string; arguments: string } }> }): { areas: AreaId[]; needsPlan: boolean } | null {
  const call = reply.tool_calls.find((c) => c.function.name === CHOOSE_AREAS_NAME);
  if (!call) return null;
  try {
    const parsed = JSON.parse(call.function.arguments || "{}") as { areas?: unknown; needs_plan?: unknown };
    if (!Array.isArray(parsed.areas)) return null;
    const areas = parsed.areas.filter(isAreaId);
    return { areas: AREA_IDS.filter((id) => areas.includes(id)).slice(0, 2), needsPlan: parsed.needs_plan === true };
  } catch {
    return null;
  }
}

export interface RouteInput {
  question: string;
  history: ChatMessage[];
  context?: Array<{ type: RefType }>;
  /** The model stage; absent, the router stops after the cheap stages. */
  chat?: ChatFn;
  signal?: AbortSignal;
  withSlot?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * The areas of a turn. Every area (`stage: "all"`) when the keywords name
 * too many, when nothing names one and there is no model, or when the model
 * chose nothing — the loop then works as it did before the router.
 */
export async function route(input: RouteInput): Promise<Routing> {
  const q = input.question;
  const decided = (areas: AreaId[], stage: RoutingStage, plan = false): Routing =>
    ({ areas, stage, needsPlan: plan || needsPlan(q, areas, stage) });
  const byWords = areasByKeywords(q);
  const inherited = areasOfLastTurn(input.history);
  const fromContext = areasOfContext(input.context ?? []);
  if (byWords.length) {
    // The working set is what the user handed over to talk about; a
    // follow-up keeps the previous turn's areas as well.
    const areas = union(byWords, fromContext, looksLikeFollowUp(q) ? inherited : []);
    if (areas.length > MAX_KEYWORD_AREAS) return decided(AREA_IDS, "all");
    return decided(areas, "keywords");
  }
  if (inherited.length || fromContext.length) return decided(union(inherited, fromContext), "inherited");
  if (input.chat) {
    const withSlot = input.withSlot ?? ((fn) => fn());
    try {
      const reply = await withSlot(() => input.chat!(routerRequest(q), undefined, input.signal));
      const chosen = parseChoice(reply);
      if (chosen?.areas.length) return decided(chosen.areas, "model", chosen.needsPlan);
    } catch (err) {
      // The user's cancel ends the turn; anything else leaves every area in play.
      if (input.signal?.aborted) throw err;
    }
  }
  return decided(AREA_IDS, "all");
}
