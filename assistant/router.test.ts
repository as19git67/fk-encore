/**
 * The router (assistent-wegfindung.md, stage 1): keywords first, then the
 * previous turn, then a short model call, and every area when nothing
 * decides.
 */

import { describe, it, expect, vi } from "vitest";

import {
  AREA_IDS,
} from "./areas/index";
import {
  areasByKeywords,
  areasOfContext,
  areasOfLastTurn,
  CHOOSE_AREAS_NAME,
  isRouterRequest,
  looksLikeFollowUp,
  parseAreaChoice,
  route,
  routerRequest,
} from "./router";
import type { ChatFn, ChatReply, ChatRequest } from "./llm-client";
import type { ChatMessage } from "./types";

const HISTORY: ChatMessage[] = [
  { role: "user", content: "Zeig meine Favoriten von 2025." },
  { role: "assistant", content: null, tool_calls: [{ id: "h1", type: "function", function: { name: "list_photos", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "h1", content: "[earlier result of list_photos: 3 rows, ids 1,2,3]" },
  { role: "assistant", content: "Du hast 3 Favoriten aus 2025." },
];

function choosing(areas: unknown): ChatReply {
  return {
    content: null, finish_reason: "tool_calls",
    tool_calls: [{ id: "r1", type: "function", function: { name: CHOOSE_AREAS_NAME, arguments: JSON.stringify({ areas }) } }],
  };
}

describe("keywords", () => {
  it("find the areas a question names, in catalog order", () => {
    expect(areasByKeywords("Welche Lastschriften muss ich diesen Monat noch erwarten?")).toEqual(["finance"]);
    expect(areasByKeywords("Wie hoch war unser Stromverbrauch im letzten Jahr?")).toEqual(["meters"]);
    expect(areasByKeywords("Zeige mir die 20 besten Fotos aus Beispielland.")).toEqual(["photos"]);
    expect(areasByKeywords("Welche Dokumente sind für meine Steuererklärung 2025 relevant?")).toEqual(["documents", "tax"]);
    expect(areasByKeywords("Ist meine PV-Anlage eigentlich steuerfrei?")).toEqual(["businesses", "tax"]);
    expect(areasByKeywords("Schreib dem Vermieter, dass die Miete überwiesen ist.")).toEqual(["finance", "writing"]);
    expect(areasByKeywords("Wie steht mein Depot?")).toEqual(["depot"]);
    expect(areasByKeywords("Welche Urlaubsreisen haben wir letztes Jahr gemacht?")).toEqual(["trips"]);
  });

  it("find nothing in small talk or a bare follow-up", () => {
    expect(areasByKeywords("Danke, das war's schon.")).toEqual([]);
    expect(areasByKeywords("Ja.")).toEqual([]);
    expect(areasByKeywords("Hallo")).toEqual([]);
  });

  it("match at a word start only, so 'Position' is depot but 'Komposition' is not", () => {
    expect(areasByKeywords("Welche Position ist die größte?")).toEqual(["depot"]);
    expect(areasByKeywords("Die Komposition gefällt mir.")).toEqual([]);
  });
});

describe("the previous turn and the working set", () => {
  it("inherit the areas of the tools the last turn called", () => {
    expect(areasOfLastTurn(HISTORY)).toEqual(["photos"]);
    expect(areasOfLastTurn([])).toEqual([]);
    expect(areasOfLastTurn([{ role: "user", content: "Hallo" }, { role: "assistant", content: "Hallo!" }])).toEqual([]);
  });

  it("read a follow-up by its words or its brevity", () => {
    expect(looksLikeFollowUp("Nur die aus München, und mach daraus ein Album.")).toBe(true);
    expect(looksLikeFollowUp("Ja.")).toBe(true);
    expect(looksLikeFollowUp("Gib denen den Tag Renovierung.")).toBe(true);
    expect(looksLikeFollowUp("Welche Zähler haben wir eigentlich alle im Haus?")).toBe(false);
  });

  it("map the working set's types to areas", () => {
    expect(areasOfContext([{ type: "document" }, { type: "document" }, { type: "transaction" }])).toEqual(["finance", "documents"]);
  });
});

describe("route", () => {
  it("decides by keywords first, and adds the previous turn's area to a follow-up", async () => {
    expect(await route({ question: "Welche Zähler haben wir?", history: [] })).toEqual({ areas: ["meters"], stage: "keywords" });
    expect(await route({ question: "Nur die aus München, und mach daraus ein Album.", history: HISTORY })).toEqual({ areas: ["photos"], stage: "keywords" });
    // A follow-up that names another area keeps the previous one too.
    expect(await route({ question: "Und dazu die Buchungen von denen?", history: HISTORY })).toEqual({ areas: ["finance", "photos"], stage: "keywords" });
  });

  it("inherits the previous turn's areas for a question without a keyword", async () => {
    expect(await route({ question: "Ja.", history: HISTORY })).toEqual({ areas: ["photos"], stage: "inherited" });
    expect(await route({ question: "Nenn es lieber Sommer 2025.", history: HISTORY })).toEqual({ areas: ["photos"], stage: "inherited" });
    // The working set joins what the words name.
    expect(await route({ question: "Mach daraus eine Collage.", history: [], context: [{ type: "photo" }] })).toEqual({ areas: ["photos"], stage: "keywords" });
    expect(await route({ question: "Fasse die drei kurz zusammen.", history: [], context: [{ type: "document" }] })).toEqual({ areas: ["documents", "writing"], stage: "keywords" });
    expect(await route({ question: "Was steht in denen?", history: [], context: [{ type: "document" }] })).toEqual({ areas: ["documents"], stage: "inherited" });
  });

  it("leaves every area in play when the keywords name too many", async () => {
    const broad = "Zeig mir Fotos, Buchungen, Zähler und Dokumente von gestern.";
    expect(await route({ question: broad, history: [] })).toEqual({ areas: AREA_IDS, stage: "all" });
  });

  it("asks the model when nothing else decides, with a short prompt bound to one tool", async () => {
    const requests: ChatRequest[] = [];
    const chat: ChatFn = async (req) => {
      requests.push(req);
      return choosing(["meters", "finance"]);
    };
    const slots: string[] = [];
    const result = await route({
      question: "Was war der letzte Stand?", history: [], chat,
      withSlot: async (fn) => { slots.push("slot"); return fn(); },
    });
    expect(result).toEqual({ areas: ["finance", "meters"], stage: "model" });
    expect(requests).toHaveLength(1);
    expect(isRouterRequest(requests[0]!)).toBe(true);
    expect(requests[0]!.tool_choice).toBe("required");
    expect(requests[0]!.max_tokens).toBe(64);
    expect((requests[0]!.messages[0] as { content: string }).content).toContain("- meters: Zähler:");
    expect(requests[0]!.messages.at(-1)).toEqual({ role: "user", content: "Was war der letzte Stand?" });
    expect(slots).toEqual(["slot"]);
  });

  it("falls back to every area when the model chooses nothing, answers in words, or fails", async () => {
    const none: ChatFn = async () => choosing([]);
    expect(await route({ question: "Was war der letzte Stand?", history: [], chat: none })).toEqual({ areas: AREA_IDS, stage: "all" });
    const words: ChatFn = async () => ({ content: "meters", tool_calls: [], finish_reason: "stop" });
    expect(await route({ question: "Was war der letzte Stand?", history: [], chat: words })).toEqual({ areas: AREA_IDS, stage: "all" });
    const failing: ChatFn = async () => { throw new Error("llm-service unreachable"); };
    expect(await route({ question: "Was war der letzte Stand?", history: [], chat: failing })).toEqual({ areas: AREA_IDS, stage: "all" });
    // Without a model stage the cheap stages decide alone.
    expect(await route({ question: "Was war der letzte Stand?", history: [] })).toEqual({ areas: AREA_IDS, stage: "all" });
  });

  it("rethrows the user's cancel", async () => {
    const controller = new AbortController();
    const cancelled: ChatFn = async () => { controller.abort(new Error("Abbrechen")); throw new Error("Abbrechen"); };
    await expect(route({ question: "Was war der letzte Stand?", history: [], chat: cancelled, signal: controller.signal })).rejects.toThrow("Abbrechen");
  });

  it("parses the model's choice strictly: known ids only, at most two", () => {
    expect(parseAreaChoice(choosing(["photos", "nonsense", "finance", "meters"]))).toEqual(["finance", "photos"]);
    expect(parseAreaChoice(choosing("photos"))).toBeNull();
    expect(parseAreaChoice({ tool_calls: [{ function: { name: CHOOSE_AREAS_NAME, arguments: "{not json" } }] })).toBeNull();
    expect(parseAreaChoice({ tool_calls: [] })).toBeNull();
    expect(isRouterRequest(routerRequest("x"))).toBe(true);
    expect(isRouterRequest({ messages: [], tools: [{ type: "function", function: { name: "list_meters" } }] })).toBe(false);
  });
});
