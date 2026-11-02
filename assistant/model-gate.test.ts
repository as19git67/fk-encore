/**
 * The gate in front of the assistant: the loaded model takes questions only
 * when its latest benchmark run passed enough cases. Model names are made up.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { getAuthData } from "~encore/auth";
import { inArray, sql } from "drizzle-orm";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);
vi.mock("./titles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./titles")>()),
  suggestTitle: vi.fn(async () => null),
}));
vi.mock("./llm-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./llm-client")>();
  return { ...real, chat: vi.fn() };
});

import db from "../db/database";
import { assistantBenchmarkRun } from "../db/schema";
import { __resetRateLimiterForTests } from "../user/rateLimiter";
import { clients, resetClients } from "./clients.test-helper";
import { chat } from "./llm-client";
import { ask, createConversation, getModelGate } from "./assistant";
import { DEFAULT_MIN_PASS_RATE, forgetModelGate, modelGate, onCpu, verdict } from "./model-gate";

const USER = 736;
const STRONG = "gate-test-strong.gguf";
const WEAK = "gate-test-weak.gguf";
const NEW = "gate-test-new.gguf";
const made: number[] = [];

function live(filename: string, accelerator: "cpu" | "cuda") {
  clients.user.getLlmGpuLease.mockResolvedValue({
    lease: { active: accelerator === "cpu" },
    reload: { state: "ready" },
    llm_loaded: true,
    config: { label: filename.replace(".gguf", ""), model_filename: filename, accelerator, gpu_layers: accelerator === "cpu" ? 0 : 99 },
  });
}

async function run(filename: string, passRate: number, opts: { accelerator?: string; status?: "done" | "cancelled"; data?: "canned" | "synthetic"; finished?: string } = {}) {
  const [row] = await db
    .insert(assistantBenchmarkRun)
    .values({
      label: filename,
      model: { model_filename: filename, ...(opts.accelerator ? { accelerator: opts.accelerator } : {}) },
      status: opts.status ?? "done",
      data_source: opts.data ?? "canned",
      cases_total: 10,
      summary: { pass_rate: passRate },
      finished_at: opts.finished ?? "2026-10-28 12:00:00+00",
    })
    .returning({ id: assistantBenchmarkRun.id });
  made.push(row!.id);
}

beforeEach(async () => {
  if (made.length) await db.delete(assistantBenchmarkRun).where(inArray(assistantBenchmarkRun.id, made.splice(0)));
  await db.execute(sql`INSERT INTO users (id, email, name, password_hash) VALUES (${USER}, 'gate@test.local', 'User736', 'x') ON CONFLICT (id) DO NOTHING`);
  resetClients();
  vi.mocked(chat).mockReset();
  __resetRateLimiterForTests();
  forgetModelGate();
  vi.mocked(getAuthData).mockReturnValue({ userID: String(USER), permissions: ["module.assistant"] });
});

afterAll(async () => {
  if (made.length) await db.delete(assistantBenchmarkRun).where(inArray(assistantBenchmarkRun.id, made.splice(0)));
});

describe("the verdict", () => {
  it("lets a model through at the threshold, slow on the CPU, and holds back one below it", () => {
    expect(verdict(1, false, 0.85)).toBe("ok");
    expect(verdict(0.85, true, 0.85)).toBe("slow");
    expect(verdict(0.42, true, 0.85)).toBe("blocked");
    expect(verdict(null, false, 0.85)).toBe("unmeasured");
  });

  it("reads the device from the accelerator, else from the layers on the card", () => {
    expect(onCpu({ accelerator: "cpu", gpu_layers: 99 })).toBe(true);
    expect(onCpu({ gpu_layers: 0 })).toBe(true);
    expect(onCpu({ gpu_layers: 99 })).toBe(false);
    expect(onCpu({})).toBeNull();
  });
});

describe("modelGate", () => {
  it("takes the latest finished run of the loaded file on the same device", async () => {
    await run(STRONG, 0.6, { accelerator: "cuda", finished: "2026-10-20 12:00:00+00" });
    await run(STRONG, 1, { accelerator: "cuda", finished: "2026-10-28 12:00:00+00" });
    // Not counted: the CPU twin, a cancelled run, the synthetic data.
    await run(STRONG, 0.5, { accelerator: "cpu", finished: "2026-10-29 12:00:00+00" });
    await run(STRONG, 0.1, { accelerator: "cuda", status: "cancelled", finished: "2026-10-30 12:00:00+00" });
    await run(STRONG, 0.2, { accelerator: "cuda", data: "synthetic", finished: "2026-10-30 12:00:00+00" });
    live(STRONG, "cuda");
    expect(await modelGate()).toMatchObject({ state: "ok", pass_rate: 1, threshold: DEFAULT_MIN_PASS_RATE, model: "gate-test-strong" });
  });

  it("calls the CPU twin slow when it passed, and a weak model blocked", async () => {
    await run(STRONG, 0.95, { accelerator: "cpu" });
    live(STRONG, "cpu");
    expect((await modelGate()).state).toBe("slow");

    forgetModelGate();
    // A run from before the device was recorded counts for either.
    await run(WEAK, 0.42);
    live(WEAK, "cpu");
    expect(await modelGate()).toMatchObject({ state: "blocked", pass_rate: 0.42 });
  });

  it("lets an unmeasured model answer, and says nothing when llm-service is silent", async () => {
    live(NEW, "cuda");
    expect((await modelGate()).state).toBe("unmeasured");
    forgetModelGate();
    clients.user.getLlmGpuLease.mockRejectedValue(new Error("unreachable"));
    expect((await modelGate()).state).toBe("unknown");
  });

  it("keeps the verdict for a minute instead of asking on every question", async () => {
    live(NEW, "cuda");
    await modelGate(1_000);
    await modelGate(30_000);
    expect(clients.user.getLlmGpuLease).toHaveBeenCalledTimes(1);
    await modelGate(62_000);
    expect(clients.user.getLlmGpuLease).toHaveBeenCalledTimes(2);
  });
});

describe("asking", () => {
  it("refuses a question while a weak model is loaded, and the page says why", async () => {
    await run(WEAK, 0.42);
    live(WEAK, "cpu");
    const conversation = await createConversation({});
    await expect(ask({ id: conversation.id, message: "Welche Lastschriften kommen diesen Monat?" }))
      .rejects.toMatchObject({ code: "failed_precondition" });
    expect(chat).not.toHaveBeenCalled();

    const gate = await getModelGate();
    expect(gate.state).toBe("blocked");
    expect(gate.message).toContain("42 %");
    expect(gate.message).toContain("85 %");
    expect(gate.message).not.toContain("Benchmark");
  });
});
