import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./clients", () => ({ call: vi.fn(), endpoint: vi.fn() }));
vi.mock("../trip-planner/plan-store", () => ({ listPlans: vi.fn() }));

import { call } from "./clients";
import { listPlans } from "../trip-planner/plan-store";
import { buildSystemPrompt, fitContext, runTurn, timeGrounding } from "./agent";
import { catalogFor, HAND_TOOLS } from "./catalog";
import type { ChatRequest, ChatReply } from "./llm-client";
import type { ChatMessage, TurnEvent } from "./types";

const EVERYTHING = [
  "module.finance", "finance.view", "module.documents", "documents.view",
  "module.photos", "photos.view", "module.meters", "meters.view",
];
const USER = { userID: "7", permissions: EVERYTHING };
const NOW = new Date(2026, 9, 15, 10, 0, 0); // Thursday, 15 October 2026, local

/** A /chat stand-in that plays a script: one reply per round. */
function scripted(replies: Array<ChatReply | ((req: ChatRequest) => ChatReply)>) {
  const requests: ChatRequest[] = [];
  const fn = vi.fn(async (req: ChatRequest, onToken?: (t: string) => void) => {
    requests.push(JSON.parse(JSON.stringify(req)));
    const next = replies[requests.length - 1];
    if (!next) throw new Error("script ran out");
    const reply = typeof next === "function" ? next(req) : next;
    if (reply.content) onToken?.(reply.content);
    return reply;
  });
  return { fn, requests };
}

function calls(...list: Array<[string, Record<string, unknown>]>): ChatReply {
  return {
    content: null,
    finish_reason: "tool_calls",
    tool_calls: list.map(([name, args], i) => ({ id: `c${i}-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } })),
  };
}

function answer(text: string): ChatReply {
  return { content: text, tool_calls: [], finish_reason: "stop" };
}

beforeEach(() => {
  vi.mocked(call).mockReset();
  vi.mocked(listPlans).mockReset();
});

describe("the example questions of #1524", () => {
  it("Lastschriften diesen Monat → upcoming_direct_debits", async () => {
    vi.mocked(call).mockResolvedValue({
      from: "2026-10-15", until: "2026-10-31", count: 1, total_amount: "-84.00",
      items: [{ mandate_id: 3, account_label: "Giro", counterparty: "Stadtwerke Musterstadt", expected_date: "2026-10-20", overdue: false, typical_amount: "-84.00", interval_days: 30 }],
    });
    const { fn, requests } = scripted([
      calls(["upcoming_direct_debits", { until: "2026-10-31" }]),
      answer("Bis Monatsende kommt noch eine Lastschrift: Stadtwerke Musterstadt, 84,00 €."),
    ]);
    const events: TurnEvent[] = [];

    const res = await runTurn({
      user: USER, history: [], question: "Welche Lastschriften muss ich in diesem Monat noch erwarten?",
      tools: catalogFor(USER), chat: fn, emit: (e) => events.push(e), now: NOW,
    });

    expect(call).toHaveBeenCalledWith("finance", "listUpcomingDebits", { from: undefined, until: "2026-10-31" });
    expect(res.answer).toContain("Stadtwerke");
    expect(res.rounds).toBe(2);
    expect(res.blocks[0]).toMatchObject({ kind: "debits", route: "/finanzen/lastschriften" });
    // The tool result the model saw carries the sum the server computed.
    const toolMsg = requests[1].messages.find((m) => m.role === "tool") as { content: string };
    expect(toolMsg.content).toContain("-84.00");
    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_result", "token", "done"]);
    // question, tool call, tool result, answer
    expect(res.transcript.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("Protokolle der Eigentümerversammlung → list_categories, then search_documents with the slug", async () => {
    vi.mocked(call).mockImplementation(async (_svc, name) => {
      if (name === "listDocumentCategories") {
        return { items: [
          { id: 1, slug: "kapitalanlage", name: "Kapitalanlage", parent_id: null },
          { id: 2, slug: "kapitalanlage-immobilie-muenchen", name: "Immobilie München", parent_id: 1 },
        ] };
      }
      return { items: [{ id: 101, title: "Protokoll Eigentümerversammlung 2025", doc_date: "2025-06-12", correspondent_display: "Muster Hausverwaltung", category_slug: "kapitalanlage-immobilie-muenchen" }] };
    });
    const { fn, requests } = scripted([
      calls(["list_categories", {}]),
      calls(["search_documents", { q: "Protokoll Eigentümerversammlung", category: "kapitalanlage-immobilie-muenchen" }]),
      answer("Ich habe ein Protokoll gefunden."),
    ]);

    const res = await runTurn({
      user: USER, history: [], question: "Gib mir alle Protokolle der Eigentümerversammlung der Immobilie in München.",
      tools: catalogFor(USER), chat: fn, now: NOW,
    });

    expect(call).toHaveBeenNthCalledWith(1, "documents", "listDocumentCategories");
    expect(call).toHaveBeenNthCalledWith(2, "documents", "searchDocumentsEndpoint", expect.objectContaining({
      q: "Protokoll Eigentümerversammlung", category: "kapitalanlage-immobilie-muenchen", mode: "hybrid",
    }));
    // The category tool shows the path, so the model can find "München".
    const catResult = requests[1].messages.at(-1) as { content: string };
    expect(catResult.content).toContain("Kapitalanlage › Immobilie München");
    expect(res.blocks.at(-1)?.route).toBe("/dokumente?q=Protokoll+Eigent%C3%BCmerversammlung&category=kapitalanlage-immobilie-muenchen");
  });

  it("Urlaubsreisen letztes Jahr → list_recaps(kind trip, 2025) and list_trip_plans together", async () => {
    vi.mocked(call).mockResolvedValue({ recaps: [
      { id: 7, kind: "trip", title: "Sommer am Gardasee", subtitle: null, period_start: "2025-08-02", period_end: "2025-08-16", photo_count: 212 },
      { id: 8, kind: "trip", title: "Ostsee", subtitle: null, period_start: "2024-07-20", period_end: "2024-08-03", photo_count: 90 },
      { id: 9, kind: "person", title: "Mit Oma", subtitle: null, period_start: "2025-01-01", period_end: "2025-12-31", photo_count: 40 },
    ] });
    vi.mocked(listPlans).mockResolvedValue([
      { id: 4, title: "Gardasee", legTitles: ["Beispielort"], dayCount: 14, startDate: "2025-08-02", updatedAt: "2025-07-01" },
      { id: 5, title: "Herbst", legTitles: [], dayCount: 3, startDate: "2026-10-10", updatedAt: "2026-09-01" },
    ] as never);
    const { fn, requests } = scripted([
      calls(["list_recaps", { kind: "trip", year: 2025 }], ["list_trip_plans", { year: 2025 }]),
      answer("Letztes Jahr wart ihr am Gardasee."),
    ]);

    const res = await runTurn({
      user: USER, history: [], question: "Welche Urlaubsreisen haben wir letztes Jahr gemacht?",
      tools: catalogFor(USER), chat: fn, now: NOW,
    });

    expect(call).toHaveBeenCalledWith("photo", "listRecaps");
    expect(listPlans).toHaveBeenCalledWith(7);
    const results = requests[1].messages.filter((m) => m.role === "tool") as Array<{ content: string }>;
    expect(results[0].content).toContain("Sommer am Gardasee");
    expect(results[0].content).not.toContain("Ostsee");
    expect(results[0].content).not.toContain("Mit Oma");
    expect(results[1].content).toContain("Gardasee");
    expect(results[1].content).not.toContain("Herbst");
    expect(res.blocks.map((b) => b.kind)).toEqual(["recaps", "trip_plans"]);
  });

  it("Album mit den Favoriten von 2025 → list_photos(favorite, 2025)", async () => {
    vi.mocked(call).mockResolvedValue({ photos: [{ id: 11, taken_at: "2025-03-01T10:00:00Z" }, { id: 12, taken_at: "2025-07-01T10:00:00Z" }] });
    const { fn } = scripted([
      calls(["list_photos", { favorite: true, date_from: "2025-01-01", date_to: "2025-12-31" }]),
      answer("Ich habe 2 favorisierte Fotos aus 2025 gefunden."),
    ]);

    const res = await runTurn({
      user: USER, history: [], question: "Mach mir ein Album mit allen favorisierten Bildern von 2025.",
      tools: catalogFor(USER), chat: fn, now: NOW,
    });

    expect(call).toHaveBeenCalledWith("photo", "listPhotos", expect.objectContaining({
      favorite: true, dateFrom: "2025-01-01", dateTo: "2025-12-31",
    }));
    expect(res.blocks[0]).toMatchObject({
      kind: "photos", total: 2, route: "/fotos/galerie?favorite=true&dateFrom=2025-01-01&dateTo=2025-12-31",
    });
  });
});

describe("the loop", () => {
  it("grounds time and lists the catalog in the system prompt", async () => {
    const { fn, requests } = scripted([answer("Hallo.")]);
    await runTurn({ user: USER, history: [], question: "Hallo", tools: catalogFor(USER), chat: fn, now: NOW });
    const system = requests[0].messages[0] as { content: string };
    expect(system.content).toContain("Today is Thursday, 2026-10-15.");
    expect(system.content).toContain('"last year" = 2025-01-01..2025-12-31');
    expect(system.content).toContain("- upcoming_direct_debits:");
    expect(requests[0].tools).toHaveLength(catalogFor(USER).length);
    expect(timeGrounding(NOW)).toContain('"last month" = 2026-09-01..2026-09-30');
  });

  it("a tool the user may not use is refused even when the model asks for it", async () => {
    const noFinance = { userID: "7", permissions: EVERYTHING.filter((p) => p !== "finance.view") };
    const { fn, requests } = scripted([
      calls(["list_transactions", { q: "Miete" }]),
      answer("Dafür habe ich keinen Zugriff."),
    ]);
    await runTurn({ user: noFinance, history: [], question: "Zeig mir die Miete", tools: HAND_TOOLS, chat: fn, now: NOW });
    expect(call).not.toHaveBeenCalled();
    const result = requests[1].messages.at(-1) as { content: string };
    expect(result.content).toBe("error: list_transactions is not in the catalog");
    expect(requests[0].tools!.some((t) => (t as { function: { name: string } }).function.name === "list_transactions")).toBe(false);
  });

  it("a failing tool becomes an error the model can explain", async () => {
    vi.mocked(call).mockRejectedValue(new Error("meter not found"));
    const { fn, requests } = scripted([calls(["latest_readings", { meter_id: 99 }]), answer("Den Zähler gibt es nicht.")]);
    const events: TurnEvent[] = [];
    await runTurn({ user: USER, history: [], question: "Stand?", tools: catalogFor(USER), chat: fn, now: NOW, emit: (e) => events.push(e) });
    expect((requests[1].messages.at(-1) as { content: string }).content).toBe("error: latest_readings failed: meter not found");
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ error: "meter not found" });
  });

  it("the last round forbids tools, so the loop always ends with an answer", async () => {
    vi.mocked(call).mockResolvedValue({ items: [] });
    const { fn, requests } = scripted([
      calls(["list_accounts", {}]),
      { content: "Keine Konten.", tool_calls: [{ id: "z", type: "function", function: { name: "list_accounts", arguments: "{}" } }], finish_reason: "tool_calls" },
    ]);
    const res = await runTurn({ user: USER, history: [], question: "Konten?", tools: catalogFor(USER), chat: fn, now: NOW, maxRounds: 2 });
    expect(requests.map((r) => r.tool_choice)).toEqual(["auto", "none"]);
    expect(res.answer).toBe("Keine Konten.");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("past the schema budget the model gets describe_tools and fetches schemas first", async () => {
    vi.mocked(call).mockResolvedValue({ meters: [] });
    const { fn, requests } = scripted([
      calls(["list_meters", {}]),
      calls(["describe_tools", { names: ["list_meters"] }]),
      calls(["list_meters", {}]),
      answer("Keine Zähler."),
    ]);
    await runTurn({ user: USER, history: [], question: "Zähler?", tools: catalogFor(USER), chat: fn, now: NOW, schemaBudgetTokens: 1 });
    const offered = requests.map((r) => (r.tools ?? []).map((t) => (t as { function: { name: string } }).function.name));
    expect(offered[0]).toEqual(["describe_tools"]);
    expect((requests[1].messages.at(-1) as { content: string }).content).toBe("error: call describe_tools for list_meters first");
    expect(offered[2]).toEqual(["describe_tools", "list_meters"]);
    expect(call).toHaveBeenCalledTimes(1);
    expect((requests[0].messages[0] as { content: string }).content).toContain("fetch a tool's argument schema with describe_tools");
  });

  it("replays history and keeps the question when the context runs short", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "alt ".repeat(400) },
      { role: "assistant", content: "antwort ".repeat(400) },
      { role: "user", content: "neu" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "x", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: "row ".repeat(800) },
      { role: "assistant", content: null, tool_calls: [{ id: "t2", type: "function", function: { name: "y", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t2", content: "fresh" },
    ];
    const digests = new Map([["t1", "[earlier result of x: 3 rows]"]]);
    const removed = fitContext(messages, digests, 300, { protectFrom: 6, questionIndex: 3 });
    expect(removed).toBe(2);
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "tool"]);
    expect((messages[3] as { content: string }).content).toBe("[earlier result of x: 3 rows]");
    expect((messages[5] as { content: string }).content).toBe("fresh");
    expect(buildSystemPrompt([], NOW, false)).toContain("no tools");
  });
});
