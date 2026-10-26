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
  const call = reply.tool_calls.find((c) => c.function.name === CHOOSE_AREAS_NAME);
  if (!call) return null;
  try {
    const parsed = JSON.parse(call.function.arguments || "{}") as { areas?: unknown };
    if (!Array.isArray(parsed.areas)) return null;
    const areas = parsed.areas.filter(isAreaId);
    return AREA_IDS.filter((id) => areas.includes(id)).slice(0, 2);
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
  const byWords = areasByKeywords(input.question);
  const inherited = areasOfLastTurn(input.history);
  const fromContext = areasOfContext(input.context ?? []);
  if (byWords.length) {
    // The working set is what the user handed over to talk about; a
    // follow-up keeps the previous turn's areas as well.
    const areas = union(byWords, fromContext, looksLikeFollowUp(input.question) ? inherited : []);
    if (areas.length > MAX_KEYWORD_AREAS) return { areas: AREA_IDS, stage: "all" };
    return { areas, stage: "keywords" };
  }
  if (inherited.length || fromContext.length) return { areas: union(inherited, fromContext), stage: "inherited" };
  if (input.chat) {
    const withSlot = input.withSlot ?? ((fn) => fn());
    try {
      const reply = await withSlot(() => input.chat!(routerRequest(input.question), undefined, input.signal));
      const chosen = parseAreaChoice(reply);
      if (chosen?.length) return { areas: chosen, stage: "model" };
    } catch (err) {
      // The user's cancel ends the turn; anything else leaves every area in play.
      if (input.signal?.aborted) throw err;
    }
  }
  return { areas: AREA_IDS, stage: "all" };
}
