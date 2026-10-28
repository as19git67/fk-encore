/**
 * The assistant benchmark: scoring, cases that match the real catalog, a
 * case run through the real agent loop, and the run endpoints. The model is
 * scripted; all data is synthetic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);
vi.mock("./llm-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./llm-client")>();
  return { ...real, chat: vi.fn() };
});

import db from "../db/database";
import { assistantBenchmarkRun } from "../db/schema";
import { clients } from "./clients.test-helper";
import { chat, MalformedReplyError, type ChatReply, type ChatRequest } from "./llm-client";
import { allTools, catalogFor } from "./catalog";
import { BENCH_CASES, type BenchCase } from "./bench/cases";
import { followUps, runBenchCase } from "./bench/runner";
import { matches, scoreCase, summarize } from "./bench/scoring";
import {
  __settleBenchmarkForTests,
  benchUser,
  cancelBenchmarkRun,
  getBenchmarkRun,
  listBenchmarkCases,
  listBenchmarkRuns,
  startBenchmarkRun,
} from "./benchmark";

function caseById(id: string): BenchCase {
  return BENCH_CASES.find((c) => c.id === id)!;
}

/**
 * A model that makes the given calls in turn, then answers. In a deferred
 * catalog it first fetches the schema of a tool it has not been offered,
 * as the real model must.
 */
function scripted(calls: Array<{ tool: string; args: Record<string, unknown> }>, answer = "Erledigt.") {
  let next = 0;
  return vi.fn(async (req: ChatRequest): Promise<ChatReply> => {
    const offered = new Set((req.tools ?? []).map((t) => (t as { function: { name: string } }).function.name));
    // A plan call (stage 3): the steps are the calls still to come.
    if (typeof req.tool_choice === "object" && req.tool_choice.function.name === "write_plan") {
      const steps = calls.slice(next).map((x) => ({ tool: x.tool, goal: x.tool }));
      return { content: null, finish_reason: "tool_calls", tool_calls: [{ id: "plan", type: "function", function: { name: "write_plan", arguments: JSON.stringify({ steps }) } }] };
    }
    const call = calls[next];
    if (!call || req.tool_choice === "none") return { content: answer, tool_calls: [], finish_reason: "stop" };
    const [name, args] = offered.has(call.tool) ? [call.tool, call.args] : ["describe_tools", { names: [call.tool] }];
    if (name === call.tool) next++;
    return {
      content: null,
      finish_reason: "tool_calls",
      tool_calls: [{ id: `c${next}-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    };
  });
}

describe("scoring", () => {
  it("compares loosely, reads nested keys and finds text in arrays", () => {
    expect(matches(2025, "2025")).toBe(true);
    expect(matches({ $contains: "MÜNCHEN" }, "München Altstadt")).toBe(true);
    expect(matches({ $all: [{ $contains: "kauf" }, { $contains: "miete" }] }, [{ name: "Kauf" }, { name: "Mieteinnahmen" }])).toBe(true);
    expect(matches({ $all: [{ $contains: "kauf" }, { $contains: "reparatur" }] }, [{ name: "Kauf" }])).toBe(false);
    expect(matches({ $in: ["2026-10-31"] }, "2026-10-31")).toBe(true);
    expect(matches({ $absent: true }, undefined)).toBe(true);
    expect(matches({ $present: true }, "")).toBe(false);

    const report = caseById("report-with-yield");
    const good = { tool: "transaction_report", args: { title: "Wohnung", groups: [{ name: "Kauf" }, { name: "Reparatur" }, { name: "Mieteinnahmen" }], yield: { investment_group: "Kauf" } } };
    expect(scoreCase(report, [good], true).passed).toBe(true);
    const noYield = { ...good, args: { ...good.args, yield: undefined } };
    expect(scoreCase(report, [noYield], true)).toMatchObject({ tool_hit: true, args_hit: false, missing: ["transaction_report"] });
  });

  it("fails a case that must not call tools when it does, and one that never answers", () => {
    const thanks = caseById("thanks-no-tool");
    expect(scoreCase(thanks, [], true).passed).toBe(true);
    expect(scoreCase(thanks, [{ tool: "list_accounts", args: {} }], true).passed).toBe(false);
    expect(scoreCase(caseById("accounts"), [{ tool: "list_accounts", args: {} }], false).passed).toBe(false);
  });

  it("summarizes rates and round times", () => {
    const pass = { tool_hit: true, args_hit: true, answered: true, passed: true, missing: [] };
    const fail = { tool_hit: true, args_hit: false, answered: true, passed: false, missing: ["x"] };
    const s = summarize([
      { rounds_ms: [100, 300], error: null, score: pass },
      { rounds_ms: [200], error: null, score: fail },
    ]);
    expect(s).toMatchObject({ cases: 2, passed: 1, pass_rate: 0.5, args_hit_rate: 0.5, rounds: 3, median_ms_per_round: 200, median_rounds_per_case: 1.5, max_rounds_used: 2 });
    // No road measured: the rates stay unknown rather than zero.
    expect(s).toMatchObject({ first_tool_hit_rate: null, nudges: 0, median_prompt_tokens_first: null });
  });

  it("summarizes the road: first tool, nudges and the prompt of round 1", () => {
    const pass = { tool_hit: true, args_hit: true, answered: true, passed: true, missing: [] };
    const s = summarize([
      { rounds_ms: [100], error: null, score: { ...pass, first_tool_hit: true }, nudges: 1, prompt_tokens_first: 5000 },
      { rounds_ms: [100], error: null, score: { ...pass, first_tool_hit: false }, nudges: 0, prompt_tokens_first: 7000 },
      { rounds_ms: [100], error: null, score: { ...pass, first_tool_hit: null }, nudges: 2, prompt_tokens_first: null },
    ]);
    expect(s).toMatchObject({ first_tool_hit_rate: 0.5, nudges: 3, median_prompt_tokens_first: 6000 });
  });

  it("summarizes how the model treats empty results and errors (stage 2)", () => {
    const pass = { tool_hit: true, args_hit: true, answered: true, passed: true, missing: [] };
    const s = summarize([
      { rounds_ms: [100], error: null, score: pass, empty_results: 2, empty_followed: 1, tool_errors: 1, errors_corrected: 1 },
      { rounds_ms: [100], error: null, score: pass, empty_results: 2, empty_followed: 2 },
    ]);
    expect(s).toMatchObject({ empty_follow_rate: 0.75, error_fix_rate: 1 });
    expect(summarize([{ rounds_ms: [100], error: null, score: pass }])).toMatchObject({ empty_follow_rate: null, error_fix_rate: null });
  });

  it("summarizes the plan of multi-area cases (stage 3)", () => {
    const pass = { tool_hit: true, args_hit: true, answered: true, passed: true, missing: [] };
    const fail = { ...pass, passed: false, args_hit: false, missing: ["x"] };
    const s = summarize([
      { rounds_ms: [100, 100, 100], error: null, score: pass, routing: "keywords", areas: ["finance", "documents"], plan_asked: true, plan: ["search_documents", "list_transactions"] },
      { rounds_ms: [100, 100, 100, 100, 100], error: null, score: fail, routing: "keywords", areas: ["meters", "documents"], plan_asked: true },
      { rounds_ms: [100, 100], error: null, score: pass, routing: "keywords", areas: ["photos"], plan_asked: true, plan: ["list_photos", "create_album"] },
      // Every area in play is no decision for two areas.
      { rounds_ms: [100], error: null, score: pass, routing: "all", areas: ["finance", "documents", "photos"] },
    ]);
    expect(s).toMatchObject({ plan_asked: 3, planned: 2, multi_area_pass_rate: 0.5, median_rounds_multi_area: 4 });
    expect(summarize([{ rounds_ms: [100], error: null, score: pass }])).toMatchObject({ plan_asked: 0, planned: 0, multi_area_pass_rate: null, median_rounds_multi_area: null, follow_up_pass_rate: null });
  });

  it("rates the follow-up cases apart (stage 4: history as summaries)", () => {
    const pass = { tool_hit: true, args_hit: true, answered: true, passed: true, missing: [] };
    const fail = { ...pass, args_hit: false, passed: false, missing: ["list_transactions"] };
    const s = summarize([
      { rounds_ms: [100], error: null, score: pass, follow_up: true },
      { rounds_ms: [100], error: null, score: fail, follow_up: true },
      { rounds_ms: [100], error: null, score: fail },
    ]);
    expect(s.follow_up_pass_rate).toBe(0.5);
  });

  it("tallies the checker's calls, objections and notes (stage 5)", () => {
    const pass = { tool_hit: true, args_hit: true, answered: true, passed: true, missing: [] };
    const s = summarize([
      { rounds_ms: [100], error: null, score: pass, checks: 2, check_failed: 1, check_ms: 400 },
      { rounds_ms: [100], error: null, score: pass, checks: 2, check_failed: 2, check_ms: 1000, unverified: true },
      { rounds_ms: [100], error: null, score: pass, checks: 1, check_failed: 0, check_ms: 300 },
      { rounds_ms: [100], error: null, score: pass },
    ]);
    expect(s).toMatchObject({ checks: 5, check_failed: 3, unverified: 1, median_check_ms: 300 });
    expect(summarize([{ rounds_ms: [100], error: null, score: pass }])).toMatchObject({ checks: 0, check_failed: 0, unverified: 0, median_check_ms: null });
  });

  it("counts the replies llama-server could not parse that the loop asked for once more", () => {
    const pass = { tool_hit: true, args_hit: true, answered: true, passed: true, missing: [] };
    const s = summarize([
      { rounds_ms: [100, 100], error: null, score: pass, malformed_replies: 1 },
      { rounds_ms: [100], error: null, score: pass },
      { rounds_ms: [100, 100, 100], error: null, score: pass, malformed_replies: 2 },
    ]);
    expect(s.malformed_replies).toBe(3);
  });

  it("counts empty results followed by another call, and errors followed by a corrected call", () => {
    expect(followUps([
      { tool: "list_transactions", args: { q: "a", from: "2026-09-01" }, rows: 0 },
      { tool: "list_transactions", args: { q: "a" }, rows: 3 },
    ])).toEqual({ empty_results: 1, empty_followed: 1, tool_errors: 0, errors_corrected: 0 });
    expect(followUps([
      { tool: "depot_transactions", args: { kind: "purchase" }, rows: 0, error: "kind must be one of …" },
      { tool: "depot_transactions", args: { kind: "buy" }, rows: 4 },
      { tool: "list_photos", args: { place: "x" }, rows: 0 },
    ])).toEqual({ empty_results: 1, empty_followed: 0, tool_errors: 1, errors_corrected: 1 });
    // The same call again is no correction; a different tool is none either.
    expect(followUps([
      { tool: "a", args: { k: 1 }, rows: 0, error: "x" },
      { tool: "a", args: { k: 1 }, rows: 0, error: "x" },
      { tool: "b", args: {}, rows: 1 },
    ])).toEqual({ empty_results: 0, empty_followed: 0, tool_errors: 2, errors_corrected: 0 });
  });

  it("judges the first tool against the case's allowed first tools", () => {
    const c = caseById("electricity-last-year");
    const report = { tool: "consumption_report", args: { meter_id: 3, from: "2025-01-01", to: "2025-12-31" } };
    expect(scoreCase(c, [{ tool: "list_meters", args: {} }, report], true).first_tool_hit).toBe(true);
    expect(scoreCase(c, [{ tool: "latest_readings", args: {} }, report], true).first_tool_hit).toBe(false);
    expect(scoreCase(c, [], false).first_tool_hit).toBeNull();
    // A case that forbids tools: a call is the wrong road, none is no verdict.
    const quiet = caseById("thanks-no-tool");
    expect(scoreCase(quiet, [], true).first_tool_hit).toBeNull();
    expect(scoreCase(quiet, [{ tool: "list_meters", args: {} }], true).first_tool_hit).toBe(false);
  });
});

describe("the cases", () => {
  const tools = new Map(allTools().map((t) => [t.name, t]));

  it("have distinct ids and expect only tools and arguments the real catalog has", () => {
    expect(new Set(BENCH_CASES.map((c) => c.id)).size).toBe(BENCH_CASES.length);
    for (const c of BENCH_CASES) {
      for (const e of c.expect) {
        const tool = tools.get(e.tool);
        expect(tool, `${c.id}: ${e.tool}`).toBeDefined();
        for (const key of Object.keys(e.args ?? {})) {
          expect(Object.keys(tool!.parameters.properties), `${c.id}: ${e.tool}.${key}`).toContain(key.split(".")[0]);
        }
      }
      for (const name of Object.keys(c.results)) expect(tools.has(name), `${c.id}: result for ${name}`).toBe(true);
    }
  });

  it("cover every write tool of the later stages", () => {
    const expected = new Set(BENCH_CASES.flatMap((c) => c.expect.map((e) => e.tool)));
    for (const name of ["create_album", "find_text_in_document", "create_collection", "build_collection_pdf", "transaction_report", "get_document_text", "render_letter", "tax_return_bundle", "tax_worksheet_pdf", "euer_pdf", "create_text_document", "create_photo_collage"]) {
      expect(expected.has(name), name).toBe(true);
    }
  });

  it("are listed for the page", async () => {
    vi.mocked(getAuthData).mockReturnValue({ userID: "1", permissions: ["data.manage"] });
    const res = await listBenchmarkCases();
    expect(res.cases).toHaveLength(BENCH_CASES.length);
    expect(res.cases.find((c) => c.id === "letter-reply-reads-text")?.tools).toEqual(["get_document_text", "render_letter"]);
  });
});

describe("running a case", () => {
  const user = benchUser();
  const tools = catalogFor(user);

  it("goes through the real loop with canned results and times each round", async () => {
    const c = caseById("letter-reply-reads-text");
    const model = scripted([
      { tool: "get_document_text", args: { id: 401 } },
      { tool: "render_letter", args: { recipient: "Beispiel Versand GmbH", body: "… Rechnung BV-77-0042 … bis zum 30.10.2026 …" } },
    ]);
    const run = await runBenchCase(c, { chat: model, tools, user });
    expect(run.error).toBeNull();
    expect(run.calls.map((x) => x.tool)).toEqual(["get_document_text", "render_letter"]);
    expect(run.score.passed).toBe(true);
    expect(run.rounds_ms.length).toBe(model.mock.calls.length);
    // The road taken, for the path metrics.
    expect(run).toMatchObject({ rounds: model.mock.calls.length, first_tool: "get_document_text", nudges: 0 });
    expect(run.score.first_tool_hit).toBe(true);
    expect(run.prompt_tokens_first).toBeGreaterThan(1000);
    // The working set reaches the system prompt, the canned text the model.
    const first = model.mock.calls[0]![0] as ChatRequest;
    expect(first.messages[0]!.content).toContain('document 401: "Mahnung"');
    const later = model.mock.calls.at(-1)![0] as ChatRequest;
    expect(JSON.stringify(later.messages)).toContain("BV-77-0042");
    // Nothing touched a service.
    expect(clients.documents.getDocumentText).not.toHaveBeenCalled();
  });

  it("hands the model an empty result with its hint, then the rows, and counts the follow-up", async () => {
    const c = caseById("empty-then-loosen-period");
    const model = scripted([
      { tool: "list_transactions", args: { q: "Musterfirma Haustechnik", from: "2026-09-01", to: "2026-09-30" } },
      { tool: "list_transactions", args: { q: "Musterfirma Haustechnik" } },
    ], "Im September nichts; die letzte Zahlung an die Musterfirma war am 12.08.2026: 120,50 €.");
    const run = await runBenchCase(c, { chat: model, tools, user });
    expect(run.score.passed).toBe(true);
    expect(run).toMatchObject({ empty_results: 1, empty_followed: 1, tool_errors: 0, errors_corrected: 0 });
    // The requests after a tool round (the router's call comes first, so the index is not fixed).
    const afterTools = model.mock.calls.map((c) => c[0] as ChatRequest).filter((r) => r.messages.at(-1)!.role === "tool");
    const result = String(afterTools[0]!.messages.at(-1)!.content);
    expect(result).toContain('{"rows":[]}');
    expect(result).toContain("without the period 2026-09-01..2026-09-30: 1");
    expect(String(afterTools[1]!.messages.at(-1)!.content)).toContain("RE-2026-0101");
  });

  it("a multi-area case gets a plan call first, follows it, and records the plan (stage 3)", async () => {
    const c = caseById("multi-invoices-paid");
    let next = 0;
    const calls = [
      { tool: "search_documents", args: { correspondent: "Musterfirma Haustechnik" } },
      { tool: "list_transactions", args: { q: "Musterfirma Haustechnik" } },
    ];
    const model = vi.fn(async (req: ChatRequest): Promise<ChatReply> => {
      const forced = typeof req.tool_choice === "object" ? req.tool_choice.function.name : null;
      if (forced === "write_plan") {
        return { content: null, finish_reason: "tool_calls", tool_calls: [{ id: "p", type: "function", function: { name: "write_plan", arguments: JSON.stringify({ steps: calls.map((x) => ({ tool: x.tool, goal: x.tool })) }) } }] };
      }
      const call = calls[next++];
      if (!call) return { content: "Zwei Rechnungen, eine bezahlt.", tool_calls: [], finish_reason: "stop" };
      return { content: null, finish_reason: "tool_calls", tool_calls: [{ id: `c${next}`, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.args) } }] };
    });
    const run = await runBenchCase(c, { chat: model, tools, user });
    expect(run.error).toBeNull();
    expect(run.score.passed).toBe(true);
    expect(run).toMatchObject({ areas: ["finance", "documents"], routing: "keywords", plan_asked: true, plan: ["search_documents", "list_transactions"], plan_done: 2 });
    // The plan call, the two tool rounds and the answer; the router decided by keywords, so no model call there.
    expect(run.rounds).toBe(4);
    const requests = model.mock.calls.map((x) => x[0] as ChatRequest);
    expect(requests[0]!.tool_choice).toEqual({ type: "function", function: { name: "write_plan" } });
    expect(String(requests[2]!.messages.at(-1)!.content)).toContain("Next: step 2, list_transactions");
    // A one-area case without chain words asks for no plan.
    const plain = await runBenchCase(caseById("bookings-by-counterparty"), { chat: scripted([{ tool: "list_transactions", args: { q: "Musterhandel", from: "2026-09-01", to: "2026-09-30" } }]), tools, user });
    expect(plain).toMatchObject({ plan_asked: false });
    expect(plain.plan).toBeUndefined();
  });

  it("a refused call counts as a tool error, and the corrected call as its correction", async () => {
    const run = await runBenchCase(caseById("bookings-by-counterparty"), {
      chat: scripted([
        { tool: "list_transactions", args: { q: "Musterhandel", from: "2026-09", to: "2026-09-30" } },
        { tool: "list_transactions", args: { q: "Musterhandel", from: "2026-09-01", to: "2026-09-30" } },
      ]),
      tools,
      user,
    });
    expect(run.score.passed).toBe(true);
    expect(run).toMatchObject({ tool_errors: 1, errors_corrected: 1 });
  });

  it("counts the replies sent once more even when the loop gave up on the second", async () => {
    const c = caseById("multi-invoices-paid");
    const unread = async (): Promise<ChatReply> => { throw new MalformedReplyError("The model produced output that does not match the expected peg-gemma4 format"); };
    const run = await runBenchCase(c, { chat: vi.fn(unread), tools, user });
    expect(run.error).toMatch(/peg-gemma4/);
    expect(run).toMatchObject({ malformed_replies: 1, rounds: 0, nudges: 1 });
  });

  it("a canned $error fails the call as a tool would", async () => {
    const c: BenchCase = { ...caseById("which-meters"), results: { list_meters: { $error: "meter service down" } } };
    const run = await runBenchCase(c, { chat: scripted([{ tool: "list_meters", args: {} }], "Der Zählerdienst antwortet nicht."), tools, user });
    expect(run).toMatchObject({ tool_errors: 1, errors_corrected: 0 });
  });

  it("names what is missing when the arguments are wrong", async () => {
    const run = await runBenchCase(caseById("debits-this-month"), {
      chat: scripted([{ tool: "upcoming_payments", args: { until: "2026-12-31" } }]),
      tools,
      user,
    });
    expect(run.score).toMatchObject({ tool_hit: true, args_hit: false, passed: false, missing: ["upcoming_payments"] });
  });

  it("runs a case with its own permissions and wants the missing one named", async () => {
    const c = caseById("balance-without-finance");
    const model = scripted([], "Für Finanzen fehlt dir die Berechtigung – wende dich an einen Administrator.");
    const run = await runBenchCase(c, { chat: model, tools, user });
    expect(run.score.passed).toBe(true);
    const offered = ((model.mock.calls[0]![0] as ChatRequest).tools ?? []).map((t) => (t as { function: { name: string } }).function.name);
    expect(offered).not.toContain("list_accounts");

    const wrong = await runBenchCase(c, { chat: scripted([], "Im System sind keine Konten angelegt."), tools, user });
    expect(wrong.score).toMatchObject({ passed: false, missing: ["answer matching /berechtigung/"] });
  });

  it("a fixture's hint may depend on the call: the letter without the deadline gets the note, the one with it does not", async () => {
    const c = caseById("letter-reply-reads-text");
    const without = scripted([
      { tool: "get_document_text", args: { id: 401 } },
      { tool: "render_letter", args: { body: "hiermit widerspreche ich der Mahnung zur Rechnung BV-77-0042." } },
    ]);
    const run = await runBenchCase(c, { chat: without, tools, user });
    expect(run.score.passed).toBe(false);
    const seen = without.mock.calls.map((x) => JSON.stringify((x[0] as ChatRequest).messages)).join("\n");
    expect(seen).toContain("also names 01.09.2026, 30.10.2026, 59,90 €, which the letter does not");

    const withIt = scripted([
      { tool: "get_document_text", args: { id: 401 } },
      { tool: "render_letter", args: { body: "Rechnung BV-77-0042 vom 01.09.2026 über 59,90 €, Frist 30.10.2026." } },
    ]);
    const ok = await runBenchCase(c, { chat: withIt, tools, user });
    expect(ok.score.passed).toBe(true);
    expect(withIt.mock.calls.map((x) => JSON.stringify((x[0] as ChatRequest).messages)).join("\n")).not.toContain("which the letter does not");
  });
});

describe("benchmark runs", () => {
  const ADMIN = 736;

  beforeEach(async () => {
    await db.execute(sql`INSERT INTO users (id, email, name, password_hash) VALUES (${ADMIN}, 'bench@test.local', 'Bench', 'x') ON CONFLICT (id) DO NOTHING`);
    await __settleBenchmarkForTests();
    await db.delete(assistantBenchmarkRun);
    vi.mocked(chat).mockReset();
    clients.user.getLlmStatus.mockReset();
    clients.user.getLlmStatus.mockResolvedValue({
      live: { label: "Beispielmodell", model_filename: "beispiel.gguf", backend: "server", ctx_size: 16384 },
    });
    vi.mocked(getAuthData).mockReturnValue({ userID: String(ADMIN), permissions: ["data.manage"] });
  });

  it("run in the background, file each case and the model, and end with a summary", async () => {
    vi.mocked(chat).mockImplementation(scripted([{ tool: "list_accounts", args: {} }], "Girokonto und Depot."));
    const started = await startBenchmarkRun({ case_ids: ["accounts", "thanks-no-tool"] });
    expect(started).toMatchObject({ status: "running", cases_total: 2, label: "Beispielmodell" });
    await __settleBenchmarkForTests();

    const run = await getBenchmarkRun({ id: started.id });
    expect(run.status).toBe("done");
    expect(run.results.map((r) => r.id)).toEqual(["accounts", "thanks-no-tool"]);
    expect(run.summary).toMatchObject({ cases: 2, passed: 2 });
    expect(run.model).toMatchObject({ model_filename: "beispiel.gguf", ctx_size: 16384 });
    expect((await listBenchmarkRuns()).runs[0]).toMatchObject({ id: started.id, status: "done" });
  });

  it("refuse a second run while one is going, and stop on cancel keeping what was measured", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    vi.mocked(chat).mockImplementation(async () => {
      calls++;
      if (calls === 2) await gate;
      return { content: "Fertig.", tool_calls: [], finish_reason: "stop" };
    });
    const started = await startBenchmarkRun({ case_ids: ["accounts", "trip-plans", "thanks-no-tool"] });
    await expect(startBenchmarkRun({})).rejects.toThrow("already in progress");

    await vi.waitFor(() => expect(calls).toBe(2));
    const cancelling = cancelBenchmarkRun({ id: started.id });
    release();
    const cancelled = await cancelling;
    expect(cancelled.status).toBe("cancelled");
    const run = await getBenchmarkRun({ id: started.id });
    expect(run.results.length).toBeGreaterThanOrEqual(1);
    expect(run.results.length).toBeLessThan(3);
    expect(run.summary?.cases).toBe(run.results.length);
  });

  it("need data.manage", async () => {
    vi.mocked(getAuthData).mockReturnValue({ userID: "1", permissions: ["module.assistant"] });
    await expect(listBenchmarkRuns()).rejects.toThrow();
  });

  describe("on the CPU twin", () => {
    const LEASE = { active: true, since: 1, previous_label: "Beispielmodell", previous_source: "file", embedder_device: "cuda" };
    const reload = (state: string, detail: string | null = null) => ({ state, detail, label: "", started_at: 1, finished_at: null });

    beforeEach(() => {
      for (const fn of [clients.user.lendLlmGpu, clients.user.returnLlmGpu, clients.user.getLlmGpuLease]) fn.mockReset();
    });

    it("lend the GPU, wait for the twin, file it as the model, run, and return the GPU", async () => {
      clients.user.lendLlmGpu.mockResolvedValue({ status: "accepted", reload: reload("stopping"), lease: LEASE });
      clients.user.returnLlmGpu.mockResolvedValue({ status: "accepted", reload: reload("stopping"), lease: LEASE });
      // Still swapping on the first poll, up on the second — both ways.
      clients.user.getLlmGpuLease
        .mockResolvedValueOnce({ lease: LEASE, reload: reload("loading"), llm_loaded: false })
        .mockResolvedValueOnce({ lease: LEASE, reload: reload("ready"), llm_loaded: true })
        .mockResolvedValueOnce({ lease: { ...LEASE, active: false }, reload: reload("ready"), llm_loaded: true });
      clients.user.getLlmStatus.mockImplementation(async () => ({
        live: clients.user.lendLlmGpu.mock.calls.length
          ? { label: "Beispielmodell (CPU)", model_filename: "beispiel.gguf", backend: "server", ctx_size: 16384, accelerator: "cpu", gpu_layers: 0, source: "lease" }
          : { label: "Beispielmodell", model_filename: "beispiel.gguf", backend: "server", ctx_size: 16384, accelerator: "cuda", gpu_layers: 99, source: "file" },
      }));
      vi.mocked(chat).mockImplementation(scripted([{ tool: "list_accounts", args: {} }], "Girokonto und Depot."));

      const started = await startBenchmarkRun({ case_ids: ["accounts"], device: "cpu" });
      expect(started.label).toBe("Beispielmodell (CPU)");
      expect(started.current_case).toBe("gpu:lend");
      await __settleBenchmarkForTests();

      const run = await getBenchmarkRun({ id: started.id });
      expect(run.status).toBe("done");
      expect(run.error).toBeNull();
      expect(run.model).toMatchObject({ gpu_layers: 0, accelerator: "cpu", source: "lease" });
      expect(run.summary).toMatchObject({ cases: 1, passed: 1 });
      expect(clients.user.lendLlmGpu).toHaveBeenCalledTimes(1);
      expect(clients.user.returnLlmGpu).toHaveBeenCalledTimes(1);
      // The model was lent before the first case ran.
      expect(clients.user.lendLlmGpu.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(chat).mock.invocationCallOrder[0]);
    });

    it("do not end a lease that was not theirs", async () => {
      clients.user.lendLlmGpu.mockResolvedValue({ status: "already_lent", reload: reload("ready"), lease: LEASE });
      vi.mocked(chat).mockImplementation(async () => ({ content: "Danke!", tool_calls: [], finish_reason: "stop" }));

      const started = await startBenchmarkRun({ case_ids: ["thanks-no-tool"], device: "cpu" });
      await __settleBenchmarkForTests();

      expect((await getBenchmarkRun({ id: started.id })).status).toBe("done");
      expect(clients.user.getLlmGpuLease).not.toHaveBeenCalled();
      expect(clients.user.returnLlmGpu).not.toHaveBeenCalled();
    });

    it("fail the run when the twin does not load, without running a case", async () => {
      clients.user.lendLlmGpu.mockResolvedValue({ status: "accepted", reload: reload("stopping"), lease: LEASE });
      clients.user.getLlmGpuLease.mockResolvedValue({
        lease: { ...LEASE, active: false },
        reload: reload("error", "RuntimeError: not enough RAM"),
        llm_loaded: true,
      });
      clients.user.returnLlmGpu.mockResolvedValue({ status: "not_lent", reload: reload("ready"), lease: { ...LEASE, active: false } });
      vi.mocked(chat).mockImplementation(async () => ({ content: "x", tool_calls: [], finish_reason: "stop" }));

      const started = await startBenchmarkRun({ case_ids: ["accounts"], device: "cpu" });
      await __settleBenchmarkForTests();

      const run = await getBenchmarkRun({ id: started.id });
      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/lending the GPU failed: RuntimeError: not enough RAM/);
      expect(run.results).toEqual([]);
      expect(chat).not.toHaveBeenCalled();
    });

    it("keep the measured cases when returning the GPU fails, and say so", async () => {
      clients.user.lendLlmGpu.mockResolvedValue({ status: "accepted", reload: reload("stopping"), lease: LEASE });
      clients.user.returnLlmGpu.mockRejectedValue(new Error("llm-service unreachable"));
      clients.user.getLlmGpuLease.mockResolvedValue({ lease: LEASE, reload: reload("ready"), llm_loaded: true });
      vi.mocked(chat).mockImplementation(async () => ({ content: "Danke!", tool_calls: [], finish_reason: "stop" }));

      const started = await startBenchmarkRun({ case_ids: ["thanks-no-tool"], device: "cpu" });
      await __settleBenchmarkForTests();

      const run = await getBenchmarkRun({ id: started.id });
      expect(run.status).toBe("done");
      expect(run.results).toHaveLength(1);
      expect(run.error).toMatch(/GPU not returned: llm-service unreachable/);
    });
  });
});
