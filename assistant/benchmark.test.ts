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
import { chat, type ChatReply, type ChatRequest } from "./llm-client";
import { allTools, catalogFor } from "./catalog";
import { BENCH_CASES, type BenchCase } from "./bench/cases";
import { runBenchCase } from "./bench/runner";
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
    for (const name of ["create_album", "find_text_in_document", "create_collection", "build_collection_pdf", "transaction_report", "get_document_text", "render_letter", "tax_return_bundle", "tax_worksheet_pdf", "euer_pdf", "create_text_document"]) {
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
    // The working set reaches the system prompt, the canned text the model.
    const first = model.mock.calls[0]![0] as ChatRequest;
    expect(first.messages[0]!.content).toContain('document 401: "Mahnung"');
    const later = model.mock.calls.at(-1)![0] as ChatRequest;
    expect(JSON.stringify(later.messages)).toContain("BV-77-0042");
    // Nothing touched a service.
    expect(clients.documents.getDocumentText).not.toHaveBeenCalled();
  });

  it("names what is missing when the arguments are wrong", async () => {
    const run = await runBenchCase(caseById("debits-this-month"), {
      chat: scripted([{ tool: "upcoming_payments", args: { until: "2026-12-31" } }]),
      tools,
      user,
    });
    expect(run.score).toMatchObject({ tool_hit: true, args_hit: false, passed: false, missing: ["upcoming_payments"] });
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
