import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);
vi.mock("../trip-planner/plan-store", () => ({ listPlans: vi.fn() }));

import { calledEndpoints, clients, resetClients } from "./clients.test-helper";
import { listPlans } from "../trip-planner/plan-store";
import { __resetCalibrationForTests, budgetForWindow, calibrateEstimate, buildSystemPrompt, cleanAnswer, NO_ROWS_MARKER, wantsNoRows, DATA_QUESTION_NUDGE, EMPTY_RESULT_HINT, FAKE_CALL_NUDGE, FINAL_ANSWER_NUDGE, fitContext, GROUNDING_NUDGE, isDataQuestion, looksLikeFakeToolCall, looksLikeUserData, NO_ANSWER, OUT_OF_ROUNDS, runTurn, timeGrounding, withHint } from "./agent";
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
  resetClients();
  vi.mocked(listPlans).mockReset();
});

describe("the example questions of #1524", () => {
  it("Lastschriften diesen Monat → upcoming_payments(channel direct_debit)", async () => {
    clients.finance.listUpcomingDebits.mockResolvedValue({
      from: "2026-10-15", until: "2026-10-31", count: 1, total_amount: "-84.00",
      items: [{ mandate_id: 3, account_label: "Giro", counterparty: "Stadtwerke Musterstadt", expected_date: "2026-10-20", overdue: false, typical_amount: "-84.00", interval_days: 30 }],
    });
    const { fn, requests } = scripted([
      calls(["upcoming_payments", { until: "2026-10-31", channel: "direct_debit" }]),
      answer("Bis Monatsende kommt noch eine Lastschrift: Stadtwerke Musterstadt, 84,00 €."),
    ]);
    const events: TurnEvent[] = [];

    const res = await runTurn({
      user: USER, history: [], question: "Welche Lastschriften muss ich in diesem Monat noch erwarten?",
      tools: catalogFor(USER), chat: fn, emit: (e) => events.push(e), now: NOW,
    });

    expect(clients.finance.listUpcomingDebits).toHaveBeenCalledWith({ from: undefined, until: "2026-10-31", channel: "direct_debit" });
    expect(res.answer).toContain("Stadtwerke");
    expect(res.rounds).toBe(2);
    expect(res.blocks[0]).toMatchObject({ kind: "debits", route: "/finanzen/zahlungen?channel=direct_debit", subtitle: "Nur Lastschriften" });
    // The tool result the model saw carries the sum the server computed.
    const toolMsg = requests[1].messages.find((m) => m.role === "tool") as { content: string };
    expect(toolMsg.content).toContain("-84.00");
    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_result", "token", "done"]);
    // question, tool call, tool result, answer
    expect(res.transcript.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("Protokolle der Eigentümerversammlung → list_categories, then search_documents with the slug", async () => {
    clients.documents.listDocumentCategories.mockResolvedValue({ items: [
      { id: 1, slug: "kapitalanlage", name: "Kapitalanlage", parent_id: null },
      { id: 2, slug: "kapitalanlage-immobilie-muenchen", name: "Immobilie München", parent_id: 1 },
    ] });
    clients.documents.searchDocumentsEndpoint.mockResolvedValue({ items: [
      { id: 101, title: "Protokoll Eigentümerversammlung 2025", doc_date: "2025-06-12", correspondent_display: "Muster Hausverwaltung", category_slug: "kapitalanlage-immobilie-muenchen" },
    ] });
    const { fn, requests } = scripted([
      calls(["list_categories", {}]),
      calls(["search_documents", { q: "Protokoll Eigentümerversammlung", category: "kapitalanlage-immobilie-muenchen" }]),
      answer("Ich habe ein Protokoll gefunden."),
    ]);

    const res = await runTurn({
      user: USER, history: [], question: "Gib mir alle Protokolle der Eigentümerversammlung der Immobilie in München.",
      tools: catalogFor(USER), chat: fn, now: NOW,
    });

    expect(calledEndpoints()).toEqual(["documents.listDocumentCategories", "documents.searchDocumentsEndpoint"]);
    expect(clients.documents.searchDocumentsEndpoint).toHaveBeenCalledWith(expect.objectContaining({
      q: "Protokoll Eigentümerversammlung", category: "kapitalanlage-immobilie-muenchen", mode: "hybrid",
    }));
    // The category tool shows the path, so the model can find "München".
    const catResult = requests[1].messages.at(-1) as { content: string };
    expect(catResult.content).toContain("Kapitalanlage › Immobilie München");
    expect(res.blocks.at(-1)?.route).toBe("/dokumente?q=Protokoll+Eigent%C3%BCmerversammlung&category=kapitalanlage-immobilie-muenchen");
  });

  it("Urlaubsreisen letztes Jahr → list_recaps(kind trip, 2025) and list_trip_plans together", async () => {
    clients.photo.listRecaps.mockResolvedValue({ recaps: [
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

    expect(clients.photo.listRecaps).toHaveBeenCalledTimes(1);
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
    clients.photo.listPhotos.mockResolvedValue({ photos: [{ id: 11, taken_at: "2025-03-01T10:00:00Z" }, { id: 12, taken_at: "2025-07-01T10:00:00Z" }] });
    const { fn } = scripted([
      calls(["list_photos", { favorite: true, date_from: "2025-01-01", date_to: "2025-12-31" }]),
      answer("Ich habe 2 favorisierte Fotos aus 2025 gefunden."),
    ]);

    const res = await runTurn({
      user: USER, history: [], question: "Mach mir ein Album mit allen favorisierten Bildern von 2025.",
      tools: catalogFor(USER), chat: fn, now: NOW,
    });

    expect(clients.photo.listPhotos).toHaveBeenCalledWith(expect.objectContaining({
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
    expect(system.content).toContain("- upcoming_payments:");
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
    expect(calledEndpoints()).toEqual([]);
    const result = requests[1].messages.at(-1) as { content: string };
    expect(result.content).toBe("error: list_transactions is not in the catalog");
    expect(requests[0].tools!.some((t) => (t as { function: { name: string } }).function.name === "list_transactions")).toBe(false);
  });

  it("a failing tool becomes an error the model can explain", async () => {
    clients.meter.listReadings.mockRejectedValue(new Error("meter not found"));
    const { fn, requests } = scripted([calls(["latest_readings", { meter_id: 99 }]), answer("Den Zähler gibt es nicht.")]);
    const events: TurnEvent[] = [];
    await runTurn({ user: USER, history: [], question: "Stand?", tools: catalogFor(USER), chat: fn, now: NOW, emit: (e) => events.push(e) });
    expect((requests[1].messages.at(-1) as { content: string }).content).toBe("error: latest_readings failed: meter not found. Fix what it names and call again, or use another tool; do not repeat the same call.");
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ error: "meter not found" });
  });

  it("the last round forbids tools, so the loop always ends with an answer", async () => {
    clients.finance.getOverview.mockResolvedValue({ sections: [], unassigned: [] });
    const { fn, requests } = scripted([
      calls(["list_accounts", {}]),
      { content: "Keine Konten.", tool_calls: [{ id: "z", type: "function", function: { name: "list_accounts", arguments: "{}" } }], finish_reason: "tool_calls" },
    ]);
    const res = await runTurn({ user: USER, history: [], question: "Konten?", tools: catalogFor(USER), chat: fn, now: NOW, maxRounds: 2 });
    expect(requests.map((r) => r.tool_choice)).toEqual(["auto", "none"]);
    expect(res.answer).toBe("Keine Konten.");
    expect(clients.finance.getOverview).toHaveBeenCalledTimes(1);
  });

  it("past the schema budget the model gets describe_tools and fetches schemas first", async () => {
    clients.meter.listMeters.mockResolvedValue({ meters: [] });
    const { fn, requests } = scripted([
      calls(["list_meters", {}]),
      calls(["describe_tools", { names: ["list_meters"] }]),
      calls(["list_meters", {}]),
      answer("Keine Zähler."),
    ]);
    await runTurn({ user: USER, history: [], question: "Zähler?", tools: catalogFor(USER), chat: fn, now: NOW, schemaBudgetTokens: 1 });
    const offered = requests.map((r) => (r.tools ?? []).map((t) => (t as { function: { name: string } }).function.name));
    expect(offered[0]).toEqual(["describe_tools", "switch_area"]);
    expect((requests[1].messages.at(-1) as { content: string }).content).toBe("error: call describe_tools for list_meters first");
    expect(offered[2]).toEqual(["describe_tools", "switch_area", "list_meters"]);
    expect(clients.meter.listMeters).toHaveBeenCalledTimes(1);
    expect((requests[0].messages[0] as { content: string }).content).toContain("fetch a tool's argument schema with describe_tools");
  });

  it("reports the largest request's tokens, the window and the earlier questions it kept", async () => {
    const history: ChatMessage[] = [
      { role: "user", content: "alt ".repeat(5000) },
      { role: "assistant", content: "antwort" },
      { role: "user", content: "vorhin" },
      { role: "assistant", content: "ja" },
    ];
    const { fn } = scripted([
      { ...answer("Hallo."), usage: { n_ctx: 30000, prompt_tokens: 900, completion_tokens: 4 } },
    ]);
    const res = await runTurn({
      user: USER, history, question: "Hallo?", tools: [], chat: fn, now: NOW, contextTokens: 6000,
    });
    expect(res.context).toMatchObject({ used: 904, window: 30000, historyTurns: 2, keptTurns: 1, digested: 0, budget: 6000 - 1024 });
    expect(res.context.estimated).toBeGreaterThan(0);
    expect(res.context.estimated).toBeLessThanOrEqual(6000 - 1024);
  });

  it("budgets against the model's window, learnt from the first reply, and forgets the oldest first", async () => {
    __resetCalibrationForTests();
    // Eight earlier turns, each with a whole result of ~1000 estimated tokens.
    const history: ChatMessage[] = [];
    const historyDigests: Record<string, string> = {};
    for (let i = 0; i < 8; i++) {
      history.push(
        { role: "user", content: `Frage ${i}` },
        { role: "assistant", content: null, tool_calls: [{ id: `h${i}`, type: "function", function: { name: "x", arguments: "{}" } }] },
        { role: "tool", tool_call_id: `h${i}`, content: `zeile ${i} `.repeat(400) },
        { role: "assistant", content: `Antwort ${i}` },
      );
      historyDigests[`h${i}`] = `[earlier result of x: turn ${i}]`;
    }
    const { fn, requests } = scripted([{ ...answer("Ja."), usage: { n_ctx: 8000, prompt_tokens: 3000, completion_tokens: 2 } }]);
    const res = await runTurn({
      user: USER, history, historyDigests, question: "Und?", tools: [], chat: fn, now: NOW, contextWindow: 8000,
    });
    const sent = requests[0]!.messages;
    // Every question stays; the oldest results shrank to their digests, the newest are whole.
    expect(sent.filter((m) => m.role === "user")).toHaveLength(9);
    const results = sent.filter((m) => m.role === "tool").map((m) => m.content);
    expect(results[0]).toBe("[earlier result of x: turn 0]");
    expect(results.at(-1)).toBe("zeile 7 ".repeat(400));
    expect(res.context.digested).toBeGreaterThan(0);
    expect(res.context.digested).toBeLessThan(8);
    expect(res.context.window).toBe(8000);
    expect(res.context.keptTurns).toBe(8);
    __resetCalibrationForTests();
  });

  it("drops whole turns from the oldest end once every result is a digest", async () => {
    __resetCalibrationForTests();
    const history: ChatMessage[] = [];
    for (let i = 0; i < 12; i++) history.push({ role: "user", content: `frage ${i} `.repeat(300) }, { role: "assistant", content: `Antwort ${i}` });
    const { fn, requests } = scripted([answer("Ja.")]);
    const res = await runTurn({ user: USER, history, question: "Und?", tools: [], chat: fn, now: NOW, contextWindow: 9000 });
    const questions = requests[0]!.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(questions.at(-1)).toBe("Und?");
    expect(questions.length).toBeLessThan(13);
    // What stays is the newest end of the conversation, without gaps.
    expect(questions.at(-2)).toBe("frage 11 ".repeat(300));
    expect(res.context.keptTurns).toBe(questions.length - 1);
  });

  it("learns how many real tokens an estimated one is, within reason", () => {
    __resetCalibrationForTests();
    const before = budgetForWindow(30000);
    calibrateEstimate(10000, 13000);
    expect(budgetForWindow(30000)).toBeLessThan(before);
    for (let i = 0; i < 50; i++) calibrateEstimate(10000, 100000);
    expect(budgetForWindow(30000)).toBe(Math.floor((30000 * 0.95 - 1024) / 2));
    calibrateEstimate(100, 1000); // too small to say anything
    __resetCalibrationForTests();
    expect(budgetForWindow(30000)).toBe(before);
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

describe("list routes", () => {
  it("a search within one account links to that account's list with the same filters", async () => {
    clients.finance.listTransactions.mockResolvedValue({ items: [], total: 0 });
    clients.finance.getOverview.mockResolvedValue({ sections: [], unassigned: [] });
    const tool = catalogFor(USER).find((t) => t.name === "list_transactions")!;
    const ctx = { user: USER, today: "2026-10-15" };

    const scoped = await tool.run({ account_id: 4, q: "Stadtwerke", from: "2026-01-01", to: "2026-09-30", tags: ["Strom"] }, ctx);
    expect(scoped.block?.route).toBe("/finanzen/uebersicht/konto/4?q=Stadtwerke&dateFrom=2026-01-01&dateTo=2026-09-30&tags=Strom");

    // Across accounts there is no list page showing the same set.
    const all = await tool.run({ q: "Stadtwerke" }, ctx);
    expect(all.block?.route).toBeUndefined();
  });
});

describe("answers without a tool behind them", () => {
  const INVENTED = "Hier sind deine 10 neuesten Buchungen:\n1. 14.10.2026 Supermarkt −23,40 €\n2. 13.10.2026 Tankstelle −61,00 €\n3. 12.10.2026 Gehalt 2.400,00 €";

  it("are recognised by amounts, dates or a numbered list", () => {
    expect(looksLikeUserData(INVENTED)).toBe(true);
    expect(looksLikeUserData("Das kostet 12,50 €.")).toBe(true);
    expect(looksLikeUserData("Am 2026-10-01 war das.")).toBe(true);
    expect(looksLikeUserData("Gern geschehen!")).toBe(false);
    expect(looksLikeUserData("Dazu brauche ich ein Konto. Welches meinst du?")).toBe(false);
  });

  it("are sent back once, withdrawn from the stream and kept out of the transcript", async () => {
    clients.finance.listTransactions.mockResolvedValue({
      items: [{ id: 41, booking_date: "2026-10-14", amount: "-9.99", currency_code: "EUR", counterparty: "Beispiel Markt", purpose: "Einkauf", tags: [] }],
      total: 1,
    });
    const { fn, requests } = scripted([
      answer(INVENTED),
      calls(["list_transactions", { limit: 10 }]),
      answer("Die neueste Buchung ist ein Einkauf bei Beispiel Markt."),
    ]);
    const events: TurnEvent[] = [];
    const res = await runTurn({
      user: USER, history: [], question: "Zeige mir die 10 neuesten Buchungen", tools: catalogFor(USER), chat: fn,
      emit: (e) => events.push(e), now: NOW,
    });

    expect(res.answer).toBe("Die neueste Buchung ist ein Einkauf bei Beispiel Markt.");
    expect(clients.finance.listTransactions).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
    // The second request carried the invented draft and the nudge; the third no longer does.
    expect(requests[1]!.messages.at(-1)).toEqual({ role: "user", content: GROUNDING_NUDGE });
    expect(JSON.stringify(requests[2]!.messages)).not.toContain(GROUNDING_NUDGE);
    expect(events.map((e) => e.type)).toContain("retract");
    expect(JSON.stringify(res.transcript)).not.toContain("Supermarkt");
  });

  it("are accepted the second time, and never questioned after a tool call or for small talk", async () => {
    const again = scripted([answer("Das waren 116,50 €."), answer("Das waren 116,50 €.")]);
    const res = await runTurn({ user: USER, history: [], question: "Wie viel war das?", tools: catalogFor(USER), chat: again.fn, now: NOW });
    expect(res.answer).toBe("Das waren 116,50 €.");
    expect(again.requests).toHaveLength(2);

    const thanks = scripted([answer("Gern geschehen!")]);
    await runTurn({ user: USER, history: [], question: "Danke!", tools: catalogFor(USER), chat: thanks.fn, now: NOW });
    expect(thanks.requests).toHaveLength(1);
  });

  it("a question about the user's data is recognised by what it names", () => {
    expect(isDataQuestion("Welche Zähler haben wir?")).toBe(true);
    expect(isDataQuestion("Was war der letzte Zählerstand?")).toBe(true);
    expect(isDataQuestion("Wie ist mein Kontostand?")).toBe(true);
    expect(isDataQuestion("Welche Flächen sind verpachtet?")).toBe(true);
    expect(isDataQuestion("Danke!")).toBe(false);
    expect(isDataQuestion("Wie heißt du?")).toBe(false);
  });

  it("a data question answered in prose without a tool is sent back once, then the tool is called", async () => {
    clients.meter.listMeters.mockResolvedValue({ meters: [{ id: 3, name: "Strom Haus", type: "electricity", unit: "kWh", lastReadingValue: 1200, lastReadingAt: "2026-10-01T06:00:00Z" }] });
    const { fn, requests } = scripted([
      answer("Sie haben einen Stromzähler, einen Wasserzähler und einen Gaszähler."),
      calls(["list_meters", {}]),
      answer("Im System ist ein Zähler angelegt: Strom Haus."),
    ]);
    const events: TurnEvent[] = [];
    const res = await runTurn({ user: USER, history: [], question: "Welche Zähler haben wir?", tools: catalogFor(USER), chat: fn, now: NOW, emit: (e) => events.push(e) });
    expect(res.answer).toBe("Im System ist ein Zähler angelegt: Strom Haus.");
    expect(requests[1]!.messages.at(-1)).toEqual({ role: "user", content: DATA_QUESTION_NUDGE });
    expect(events.map((e) => e.type)).toContain("retract");
    expect(JSON.stringify(res.transcript)).not.toContain("Gaszähler");
  });

  it("the second answer stands even without a tool, so a clarifying question survives", async () => {
    const { fn, requests } = scripted([answer("Welchen Zähler meinst du?"), answer("Welchen Zähler meinst du?")]);
    const res = await runTurn({ user: USER, history: [], question: "Wie ist der Zählerstand?", tools: catalogFor(USER), chat: fn, now: NOW });
    expect(res.answer).toBe("Welchen Zähler meinst du?");
    expect(requests).toHaveLength(2);
  });

  it("a tool with no rows says so, instead of letting the model fill in a household's usual meters", async () => {
    clients.meter.listMeters.mockResolvedValue({ meters: [] });
    const { fn, requests } = scripted([calls(["list_meters", {}]), answer("Im System sind keine Zähler angelegt.")]);
    await runTurn({ user: USER, history: [], question: "Welche Zähler gibt es?", tools: catalogFor(USER), chat: fn, now: NOW });
    expect((requests[1]!.messages.at(-1) as { content: string }).content).toContain("No meter is registered in the system");
    expect(buildSystemPrompt(catalogFor(USER), NOW, false)).toContain("never name a meter, account, document, photo, security or trip that no tool returned");
  });

  it("are covered by the rules: the model knows nothing of the user's data", () => {
    const prompt = buildSystemPrompt(catalogFor(USER), NOW, false);
    expect(prompt).toContain("You know nothing about this user's data");
    expect(prompt).toContain('"Zeige mir die 10 neuesten Buchungen." → list_transactions(limit = 10)');
  });
});

describe("what the benchmark caught", () => {
  it("a tool call written as text is sent back, and the model then calls it", async () => {
    clients.photo.getPhotoDetailsBatch.mockResolvedValue({ photos: [{ id: 5, taken_at: "2025-06-01T10:00:00Z", location_city: "München" }] });
    const { fn, requests } = scripted([
      answer("Album vorgeschlagen.\n\n[tools behind this answer: list_photos {\"from_previous_result\":true} → 2 rows]"),
      calls(["list_photos", { from_previous_result: true, place: "München" }]),
      answer("Eins aus München."),
    ]);
    const events: TurnEvent[] = [];
    const res = await runTurn({
      user: USER, history: [], question: "Nur die aus München.", tools: catalogFor(USER), chat: fn,
      emit: (e) => events.push(e), now: NOW, previousRefs: { photo: [5, 6] },
    });
    expect(requests[1]!.messages.at(-1)).toEqual({ role: "user", content: FAKE_CALL_NUDGE });
    expect(events.some((e) => e.type === "retract")).toBe(true);
    expect(res.answer).toBe("Eins aus München.");
  });

  it("the forced last round's call-as-text is asked once more for words, and never shown", async () => {
    const raw = "<|tool_call>call:list_transactions{from:<|\"|>2019-01-01<|\"|>}<tool_call|>";
    clients.finance.listTransactions.mockResolvedValue({ items: [], total: 0 });
    const loop = scripted([calls(["list_transactions", { q: "a" }]), answer(raw), answer("Dazu habe ich keine Buchungen gefunden.")]);
    const res = await runTurn({ user: USER, history: [], question: "Kauf?", tools: catalogFor(USER), chat: loop.fn, now: NOW, maxRounds: 2 });
    expect(loop.requests[2]!.messages.at(-1)).toEqual({ role: "user", content: FINAL_ANSWER_NUDGE });
    expect(loop.requests[2]!.tools).toBeUndefined();
    expect(res.answer).toBe("Dazu habe ich keine Buchungen gefunden.");

    const stubborn = scripted([calls(["list_transactions", { q: "b" }]), answer(raw), answer(raw)]);
    const again = await runTurn({ user: USER, history: [], question: "Kauf?", tools: catalogFor(USER), chat: stubborn.fn, now: NOW, maxRounds: 2 });
    expect(again.answer).toBe(OUT_OF_ROUNDS);
  });

  it("an empty reply after the tool results is asked once more for words", async () => {
    clients.finance.listTransactions.mockResolvedValue({ items: [], total: 0 });
    const loop = scripted([calls(["list_transactions", { q: "a" }]), answer(""), answer("Keine Buchungen gefunden.")]);
    const res = await runTurn({ user: USER, history: [], question: "Kauf?", tools: catalogFor(USER), chat: loop.fn, now: NOW });
    expect(loop.requests[2]!.messages.at(-1)).toEqual({ role: "user", content: FINAL_ANSWER_NUDGE });
    expect(loop.requests[2]!.tools).toBeUndefined();
    expect(res.answer).toBe("Keine Buchungen gefunden.");
    expect(res.rounds).toBe(3);

    const silent = scripted([calls(["list_transactions", { q: "b" }]), answer(""), answer("")]);
    const again = await runTurn({ user: USER, history: [], question: "Kauf?", tools: catalogFor(USER), chat: silent.fn, now: NOW });
    expect(again.answer).toBe(NO_ANSWER);
    expect(silent.requests).toHaveLength(3);
  });

  it("a second search in the same turn replaces the first one's rows beside the answer", async () => {
    // Searching again means the first rows did not fit; both tables showed
    // a list of near misses above the one the answer is about.
    clients.documents.searchDocumentsEndpoint
      .mockResolvedValueOnce({ items: [{ id: 1, title: "Beitragsbescheid" }, { id: 2, title: "Bonusprogramm" }] })
      .mockResolvedValueOnce({ items: [{ id: 3, title: "Gesundheitsdividende einlösen" }] });
    const loop = scripted([
      calls(["search_documents", { q: "TK" }]),
      calls(["search_documents", { q: "Gesundheitsdividende" }]),
      answer("Ein Dokument passt."),
    ]);
    const res = await runTurn({ user: USER, history: [], question: "TK Gesundheitsdividende?", tools: catalogFor(USER), chat: loop.fn, now: NOW });
    expect(res.blocks.map((b) => [b.tool, b.rows.map((r) => r.id)])).toEqual([["search_documents", [3]]]);

    // Lists are not searches: two accounts are two results.
    clients.finance.listTransactions.mockResolvedValue({ items: [{ id: 9, booking_date: "2026-10-01", amount: "-1.00" }], total: 1 });
    clients.finance.getOverview.mockResolvedValue({ sections: [], unassigned: [] });
    const two = scripted([calls(["list_transactions", { account_id: 1 }], ["list_transactions", { account_id: 2 }]), answer("Zwei.")]);
    const both = await runTurn({ user: USER, history: [], question: "?", tools: catalogFor(USER), chat: two.fn, now: NOW });
    expect(both.blocks.filter((b) => b.tool === "list_transactions")).toHaveLength(2);
  });

  it("a document list from any tool replaces the document lists before it", async () => {
    // Tax documents, then a search, then the summary of what it read: one
    // trail to one list. The steps line keeps the trail.
    clients.documents.listTaxDocuments.mockResolvedValue({
      year: 2025, total_documents: 1,
      sections: [{ slug: "anlage-n", name: "Anlage N", group: "Einkünfte", documents: [{ source: "user", confidence: null, document: { id: 1, title: "Lohnsteuerbescheinigung", original_filename: "l.pdf", doc_date: "2025-12-10", correspondent_display: "Finanzamt Musterstadt", sender: null } }] }],
    });
    clients.documents.searchDocumentsEndpoint
      .mockResolvedValueOnce({ items: [{ id: 2, title: "Rechnung PV-Anlage" }, { id: 3, title: "Förderantrag" }] });
    clients.documents.getDocument.mockImplementation(async ({ id }: { id: number }) => ({ id, title: id === 2 ? "Rechnung PV-Anlage" : "Förderantrag", summary: "…" }));
    const loop = scripted([
      calls(["tax_documents", { year: 2025 }]),
      calls(["search_documents", { q: "PV-Anlage" }]),
      calls(["get_document_summary", { ids: [2, 3] }]),
      answer("Die Rechnung und der Förderantrag."),
    ]);
    const res = await runTurn({ user: USER, history: [], question: "PV-Rechnung?", tools: catalogFor(USER), chat: loop.fn, now: NOW });
    expect(clients.documents.listTaxDocuments).toHaveBeenCalledTimes(1);
    expect(res.blocks.map((b) => b.tool)).toEqual(["get_document_summary"]);
    expect(res.blocks[0]!.rows.map((r) => r.id)).toEqual([2, 3]);
    // The trail stays: every lookup is a step with its row count.
    expect(res.toolResults && Object.keys(res.toolResults)).toHaveLength(3);
  });

  it("a repeated call with the same arguments is answered from above, not run again", async () => {
    clients.finance.listTransactions.mockResolvedValue({ items: [], total: 0 });
    const { fn, requests } = scripted([
      calls(["list_transactions", { from: "2019-01-01", to: "2019-12-31" }]),
      calls(["list_transactions", { to: "2019-12-31", from: "2019-01-01" }]),
      answer("Keine Buchungen 2019."),
    ]);
    await runTurn({ user: USER, history: [], question: "2019?", tools: catalogFor(USER), chat: fn, now: NOW });
    // One list call and its one probe (the period dropped); the repeat ran nothing.
    expect(clients.finance.listTransactions).toHaveBeenCalledTimes(2);
    expect(String(requests[1]!.messages.at(-1)!.content)).toContain("No bookings match the period 2019-01-01..2019-12-31 (without it: 0, which is everything)");
    expect(String(requests[2]!.messages.at(-1)!.content)).toContain("you already called list_transactions");
  });

  it("an answer ending with the no-rows line keeps its rows out of the chat", async () => {
    // Asked for flights, found coffee bills: the model says so and ends with
    // the marker; the answer stands alone and the marker is not shown.
    clients.finance.listTransactions.mockResolvedValue({ items: [{ id: 9, booking_date: "2026-06-06", counterparty: "Beispiel Café Musterland", amount: "-2.51" }], total: 1 });
    clients.finance.getOverview.mockResolvedValue({ sections: [], unassigned: [] });
    const loop = scripted([
      calls(["list_transactions", { q: "Musterland" }]),
      answer(`Es gibt Buchungen mit "Musterland", aber keine Flugbuchung.\n\n${NO_ROWS_MARKER}`),
    ]);
    const res = await runTurn({ user: USER, history: [], question: "Flug nach Musterland?", tools: catalogFor(USER), chat: loop.fn, now: NOW });
    expect(res.answer).toBe('Es gibt Buchungen mit "Musterland", aber keine Flugbuchung.');
    expect(res.blocks).toEqual([]);
    expect(Object.keys(res.toolResults)).toHaveLength(1);

    // Without the line the rows stay beside the answer.
    const plain = scripted([calls(["list_transactions", { q: "Musterland" }]), answer("Eine Buchung.")]);
    const kept = await runTurn({ user: USER, history: [], question: "Musterland?", tools: catalogFor(USER), chat: plain.fn, now: NOW });
    expect(kept.blocks).toHaveLength(1);
  });

  it("notes about tools are taken out of the answer", () => {
    expect(cleanAnswer("Zwei Protokolle gefunden.\n\n*Tools: list_categories, search_documents*")).toBe("Zwei Protokolle gefunden.");
    expect(cleanAnswer("Werkzeuge: list_recaps\nOstsee 2024")).toBe("Ostsee 2024");
    expect(cleanAnswer("Das Tool hat 3 Treffer.")).toBe("Das Tool hat 3 Treffer.");
    expect(cleanAnswer("Keine Flüge.\n\n[[ohne Liste]]")).toBe("Keine Flüge.");
    expect(wantsNoRows("Keine Flüge. [[ ohne liste ]]")).toBe(true);
    expect(wantsNoRows("Keine Flüge.")).toBe(false);
    expect(looksLikeFakeToolCall("[tools behind this answer: x]")).toBe(true);
    expect(looksLikeFakeToolCall("Ich rufe gleich die Buchungen ab.")).toBe(false);
  });

  it("trimming drops a whole earlier turn, never a tool call without its question", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "alt ".repeat(200) },
      { role: "assistant", content: null, tool_calls: [{ id: "h1", type: "function", function: { name: "x", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "h1", content: "digest ".repeat(200) },
      { role: "assistant", content: "antwort ".repeat(200) },
      { role: "user", content: "neu" },
    ];
    const removed = fitContext(messages, new Map(), 60, { protectFrom: 6, questionIndex: 5 });
    expect(removed).toBe(4);
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
  });
});

describe("Abbrechen", () => {
  it("starts no further round or tool once the turn is cancelled", async () => {
    const controller = new AbortController();
    clients.meter.listMeters.mockImplementation(async () => {
      controller.abort();
      return { meters: [] };
    });
    const { fn } = scripted([
      calls(["list_meters", {}], ["list_accounts", {}]),
      answer("Keine Zähler."),
    ]);
    const events: TurnEvent[] = [];

    await expect(runTurn({
      user: USER, history: [], question: "Zähler und Konten?", tools: catalogFor(USER), chat: fn, now: NOW,
      emit: (e) => events.push(e), signal: controller.signal,
    })).rejects.toThrow();

    // The running tool finishes; the next one and the next round never start.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(clients.finance.listAccounts).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_result"]);
  });

  it("hands the signal to every model call", async () => {
    const controller = new AbortController();
    const { fn } = scripted([answer("Hallo.")]);
    await runTurn({ user: USER, history: [], question: "Hallo", tools: catalogFor(USER), chat: fn, now: NOW, signal: controller.signal });
    expect(fn.mock.calls[0]![2]).toBe(controller.signal);
  });
});

describe("the user's permissions (#1648)", () => {
  const NO_FINANCE = { userID: "8", permissions: ["module.assistant", "module.meters", "meters.view"] };

  it("the prompt names the areas the user may use and those without permission", () => {
    const prompt = buildSystemPrompt(catalogFor(NO_FINANCE), NOW, false, [], NO_FINANCE.permissions);
    const access = prompt.slice(prompt.indexOf("Access of this user:"));
    expect(access).toMatch(/May use: Zähler/);
    expect(access).toMatch(/No permission for: Finanzen[^\n]*Dokumente[^\n]*Fotos/);
    expect(prompt).toContain("Für Finanzen fehlt dir die Berechtigung");
  });

  it("a user with every area has no line without permission", () => {
    const prompt = buildSystemPrompt(catalogFor(USER), NOW, false, [], USER.permissions);
    expect(prompt).toContain("Access of this user:");
    expect(prompt).not.toContain("No permission for:");
  });

  it("names the proposals the catalog offers", () => {
    const user = { userID: "9", permissions: [...EVERYTHING, "albums.manage"] };
    const prompt = buildSystemPrompt(catalogFor(user), NOW, false, [], user.permissions);
    expect(prompt).toMatch(/Changes you can propose: [^\n]*create_album/);
  });

  it("a question about a missing area is answered with the missing permission, without a tool and without a nudge", async () => {
    const { fn, requests } = scripted([answer("Für Finanzen fehlt dir die Berechtigung – wende dich an einen Administrator.")]);
    const res = await runTurn({ user: NO_FINANCE, history: [], question: "Wie ist mein Kontostand?", tools: catalogFor(NO_FINANCE), chat: fn, now: NOW });
    expect(res.answer).toContain("fehlt dir die Berechtigung");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools?.map((t) => t.function.name) ?? []).not.toContain("list_accounts");
    expect(calledEndpoints()).toHaveLength(0);
  });

  it("a user with every area is still pushed to a tool, whatever the draft says", async () => {
    clients.finance.getOverview.mockResolvedValue({ sections: [], unassigned: [] });
    const { fn, requests } = scripted([
      answer("Dafür fehlt dir die Berechtigung."),
      calls(["list_accounts", {}]),
      answer("Im System sind keine Konten angelegt."),
    ]);
    await runTurn({ user: USER, history: [], question: "Wie ist mein Kontostand?", tools: catalogFor(USER), chat: fn, now: NOW });
    expect(requests[1]!.messages.at(-1)).toEqual({ role: "user", content: DATA_QUESTION_NUDGE });
  });

  it("a refused call reaches the model as no access, not as an empty result", async () => {
    clients.finance.getOverview.mockRejectedValue(Object.assign(new Error("account not accessible"), { code: "permission_denied" }));
    const { fn, requests } = scripted([calls(["list_accounts", {}]), answer("Dieses Konto kann ich nicht öffnen.")]);
    await runTurn({ user: USER, history: [], question: "Wie ist mein Kontostand?", tools: catalogFor(USER), chat: fn, now: NOW });
    expect((requests[1]!.messages.at(-1) as { content: string }).content).toContain("no access (permission_denied)");
  });
});

describe("the router and the area packages (stage 1 of assistent-wegfindung.md)", () => {
  const names = (req: ChatRequest) => (req.tools ?? []).map((t) => (t as { function: { name: string } }).function.name);

  it("offers only the tools of the areas the question names, plus switch_area, and the other areas by name", async () => {
    clients.meter.listMeters.mockResolvedValue({ meters: [] });
    const { fn, requests } = scripted([calls(["list_meters", {}]), answer("Keine Zähler.")]);
    const res = await runTurn({ user: USER, history: [], question: "Welche Zähler haben wir?", tools: catalogFor(USER), chat: fn, now: NOW });
    expect(names(requests[0]!)).toEqual(["describe_tools", "switch_area", "list_meters", "latest_readings", "consumption_report"]);
    const system = (requests[0]!.messages[0] as { content: string }).content;
    expect(system).toContain("- list_meters:");
    expect(system).not.toContain("- list_photos:");
    expect(system).not.toContain("Rules for photos:");
    expect(system).toContain("Other areas, added with switch_area(area):\n- finance:");
    expect(system).toContain('1. "Wie viel Strom haben wir letztes Jahr verbraucht?"');
    expect(system).not.toContain("Zeige mir die 10 neuesten Buchungen");
    expect(res).toMatchObject({ areas: ["meters"], routing: "keywords" });
  });

  it("the fixed part of the prompt comes first, then the day, the user, the areas", () => {
    const prompt = buildSystemPrompt(catalogFor(USER), NOW, false, ["document 1: x"], USER.permissions, ["photos"], ["finance"]);
    const at = (s: string) => prompt.indexOf(s);
    expect(at("You are the assistant")).toBe(0);
    expect(at("Today is")).toBeGreaterThan(0);
    expect(at("Access of this user:")).toBeGreaterThan(at("Today is"));
    expect(at("Working set")).toBeGreaterThan(at("Access of this user:"));
    expect(at("Rules for photos:")).toBeGreaterThan(at("Working set"));
    expect(at("Tools you may call:")).toBeGreaterThan(at("Rules for photos:"));
    expect(at("Examples of chained calls:")).toBeGreaterThan(at("Tools you may call:"));
    expect(at("Other areas")).toBeGreaterThan(at("Examples of chained calls:"));
  });

  it("with no area recognised, every area is in play, as before the router", async () => {
    const { fn, requests } = scripted([answer("Hallo!")]);
    const res = await runTurn({ user: USER, history: [], question: "Hallo", tools: catalogFor(USER), chat: fn, now: NOW });
    expect(names(requests[0]!)).toEqual(catalogFor(USER).map((t) => t.name));
    expect((requests[0]!.messages[0] as { content: string }).content).not.toContain("Other areas");
    expect(res.routing).toBe("all");
  });

  it("switch_area adds an area's rules, tools and examples for the rest of the turn", async () => {
    clients.meter.listMeters.mockResolvedValue({ meters: [] });
    const { fn, requests } = scripted([
      calls(["switch_area", { area: "meters" }]),
      calls(["list_meters", {}]),
      answer("Keine Zähler."),
    ]);
    const res = await runTurn({ user: USER, history: [], question: "Zeig mir die 10 neuesten Buchungen", tools: catalogFor(USER), chat: fn, now: NOW });
    expect(names(requests[0]!)).not.toContain("list_meters");
    const pkg = (requests[1]!.messages.at(-1) as { content: string }).content;
    expect(pkg).toContain("Tools of meters:\n- list_meters:");
    expect(pkg).toContain("Examples of chained calls:");
    expect(names(requests[1]!)).toContain("list_meters");
    expect(names(requests[1]!)).toContain("list_transactions");
    expect(clients.meter.listMeters).toHaveBeenCalledTimes(1);
    expect(res.areas).toEqual(["finance", "meters"]);
  });

  it("switch_area refuses an unknown area and notes one already in play", async () => {
    const { fn, requests } = scripted([
      calls(["switch_area", { area: "weather" }], ["switch_area", { area: "finance" }]),
      answer("Ok."),
    ]);
    await runTurn({ user: USER, history: [], question: "Zeig mir die 10 neuesten Buchungen", tools: catalogFor(USER), chat: fn, now: NOW });
    const results = requests[1]!.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
    expect(results[0]).toMatch(/^error: unknown area; one of finance, depot/);
    expect(results[1]).toBe("finance is already in play; its tools are offered.");
  });

  it("a tool of another area called by name runs, and its area joins the turn", async () => {
    clients.meter.listMeters.mockResolvedValue({ meters: [] });
    const { fn, requests } = scripted([calls(["list_meters", {}]), answer("Keine Zähler.")]);
    const res = await runTurn({ user: USER, history: [], question: "Zeig mir die 10 neuesten Buchungen", tools: catalogFor(USER), chat: fn, now: NOW });
    expect(clients.meter.listMeters).toHaveBeenCalledTimes(1);
    expect(names(requests[1]!)).toContain("consumption_report");
    expect(res.areas).toEqual(["finance", "meters"]);
  });

  it("describe_tools on a tool of another area brings that area's rules along", async () => {
    clients.photo.listPhotos.mockResolvedValue({ photos: [], total: 0 });
    const { fn, requests } = scripted([
      calls(["describe_tools", { names: ["list_photos"] }]),
      answer("Keine Fotos."),
    ]);
    await runTurn({ user: USER, history: [], question: "Zeig mir die 10 neuesten Buchungen", tools: catalogFor(USER), chat: fn, now: NOW });
    const described = (requests[1]!.messages.at(-1) as { content: string }).content;
    expect(described).toContain("list_photos:");
    expect(described).toContain("Rules for photos:");
    expect(names(requests[1]!)).toContain("list_photos");
  });

  it("the model stage runs only when asked for and nothing cheaper decided", async () => {
    clients.meter.listMeters.mockResolvedValue({ meters: [] });
    const { fn, requests } = scripted([
      { content: null, finish_reason: "tool_calls", tool_calls: [{ id: "r", type: "function", function: { name: "choose_areas", arguments: JSON.stringify({ areas: ["meters"] }) } }] },
      calls(["list_meters", {}]),
      answer("Keine Zähler."),
    ]);
    const res = await runTurn({ user: USER, history: [], question: "Was haben wir im Haus so alles installiert?", tools: catalogFor(USER), chat: fn, now: NOW, routeModel: true });
    expect(requests[0]!.tool_choice).toBe("required");
    expect(names(requests[0]!)).toEqual(["choose_areas"]);
    expect(names(requests[1]!)).toEqual(["describe_tools", "switch_area", "list_meters", "latest_readings", "consumption_report"]);
    expect(res).toMatchObject({ areas: ["meters"], routing: "model", rounds: 2 });

    const quiet = scripted([calls(["list_meters", {}]), answer("Keine Zähler.")]);
    await runTurn({ user: USER, history: [], question: "Welche Zähler haben wir?", tools: catalogFor(USER), chat: quiet.fn, now: NOW, routeModel: true });
    expect(quiet.requests).toHaveLength(2);
    expect(names(quiet.requests[0]!)).not.toContain("choose_areas");
  });

  it("a follow-up inherits the previous turn's area", async () => {
    clients.photo.listPhotos.mockResolvedValue({ photos: [], total: 0 });
    const history: ChatMessage[] = [
      { role: "user", content: "Zeig meine Favoriten von 2025." },
      { role: "assistant", content: null, tool_calls: [{ id: "h1", type: "function", function: { name: "list_photos", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "h1", content: "[earlier result of list_photos: 3 rows, ids 1,2,3]" },
      { role: "assistant", content: "Du hast 3 Favoriten aus 2025." },
    ];
    const { fn, requests } = scripted([calls(["list_photos", { from_previous_result: true, place: "München" }]), answer("Eins.")]);
    const res = await runTurn({ user: USER, history, question: "Nur die aus München.", tools: catalogFor(USER), chat: fn, now: NOW, previousRefs: { photo: [1, 2, 3] } });
    expect(names(requests[0]!)).toContain("list_photos");
    expect(names(requests[0]!)).not.toContain("list_meters");
    expect(res.routing).toBe("inherited");
  });
});

describe("tools written for the model (stage 2 of assistent-wegfindung.md)", () => {
  it("refuses a call whose arguments do not fit the schema, names the argument, and runs the corrected call", async () => {
    clients.finance.listPortfolioTransactions.mockResolvedValue({ items: [], total: 0, sums: { net_amount: "0", fees: "0", taxes: "0" } });
    const { fn, requests } = scripted([
      calls(["depot_transactions", { kind: "purchase", from: "2025" }]),
      calls(["depot_transactions", { kind: "buy", from: "2025-01-01" }]),
      answer("Keine Käufe 2025."),
    ]);
    const events: TurnEvent[] = [];
    const logged: Array<{ tool: string; error?: string }> = [];
    await runTurn({
      user: USER, history: [], question: "Welche Wertpapiere habe ich 2025 gekauft?", tools: catalogFor(USER), chat: fn, now: NOW,
      emit: (e) => events.push(e), log: (e) => logged.push({ tool: e.tool, error: e.error }),
    });
    const refused = String(requests[1]!.messages.at(-1)!.content);
    expect(refused).toBe('error: depot_transactions was not run: kind must be one of buy, sell, in, out, dividend, split, corp_action, tax; got "purchase"; from must be a day, YYYY-MM-DD; got "2025". For the year 2025 use 2025-01-01. Call depot_transactions again with the corrected arguments.');
    // Nothing ran for the refused call; the corrected one did.
    expect(clients.finance.listPortfolioTransactions).toHaveBeenCalledTimes(1);
    expect(clients.finance.listPortfolioTransactions).toHaveBeenCalledWith(expect.objectContaining({ kind: "buy", from: "2025-01-01" }));
    expect(events.filter((e) => e.type === "tool_result")).toMatchObject([{ rowCount: 0, error: expect.stringContaining("kind must be one of") }, { rowCount: 0 }]);
    expect(logged).toEqual([{ tool: "depot_transactions", error: expect.stringContaining("purchase") }, { tool: "depot_transactions", error: undefined }]);
  });

  it("an unknown argument names the one most likely meant", async () => {
    const { fn, requests } = scripted([
      calls(["list_transactions", { acount_id: 1 }]),
      answer("Hm."),
    ]);
    await runTurn({ user: USER, history: [], question: "Buchungen?", tools: catalogFor(USER), chat: fn, now: NOW });
    expect(String(requests[1]!.messages.at(-1)!.content)).toContain("unknown argument acount_id; did you mean account_id?");
    expect(clients.finance.listTransactions).not.toHaveBeenCalled();
  });

  it("a list tool with no rows says which filter to loosen and what that brings", async () => {
    clients.finance.listTransactions
      .mockResolvedValueOnce({ items: [], total: 0 })  // the call
      .mockResolvedValueOnce({ items: [], total: 412 }) // without q
      .mockResolvedValueOnce({ items: [], total: 3 });  // without the period
    const { fn, requests } = scripted([
      calls(["list_transactions", { q: "Flug", from: "2026-09-01", to: "2026-09-30" }]),
      answer("Im September keine Flüge."),
    ]);
    await runTurn({ user: USER, history: [], question: "Flüge im September?", tools: catalogFor(USER), chat: fn, now: NOW });
    const text = String(requests[1]!.messages.at(-1)!.content);
    expect(text).toContain("(0 rows)");
    expect(text).toContain('No bookings match. The same call with one filter dropped: without q "Flug": 412; without the period 2026-09-01..2026-09-30: 3. Call again with the one filter dropped that keeps what the user asked for');
    // The probes ask for one row each, the query otherwise unchanged.
    expect(clients.finance.listTransactions).toHaveBeenNthCalledWith(2, expect.objectContaining({ q: undefined, from: "2026-09-01", limit: 1 }));
    expect(clients.finance.listTransactions).toHaveBeenNthCalledWith(3, expect.objectContaining({ q: "Flug", from: undefined, to: undefined, limit: 1 }));
  });

  it("a result with no rows and no hint of its own gets the loop's hint, but only when the call had filters", () => {
    const empty = { text: "(0 rows)", digest: "d", rowCount: 0 };
    expect(withHint(empty, { q: "x" })).toBe(`(0 rows)\n\n${EMPTY_RESULT_HINT}`);
    expect(withHint(empty, {})).toBe("(0 rows)");
    expect(withHint(empty, { tags: [], q: "" })).toBe("(0 rows)");
    expect(withHint({ ...empty, hint: "own hint" }, {})).toBe("(0 rows)\n\nown hint");
    expect(withHint({ text: "rows", digest: "d", rowCount: 2 }, { q: "x" })).toBe("rows");
  });

  it("the general rules tell the model to act on the hint and on an error", () => {
    const prompt = buildSystemPrompt(catalogFor(USER), NOW, false);
    expect(prompt).toContain("call the tool again once with that filter dropped before you tell the user nothing exists");
    expect(prompt).toContain("A tool error names the argument and the allowed values: fix that argument and call again");
  });
});
