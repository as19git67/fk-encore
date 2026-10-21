import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isGpuLent, llmBudgetMs, resetLlmLeaseCache } from "./llm-lease";

/** The llm-service's /reload/status: GPU lent or not, or an error status. */
function reloadStatus(answer: { active: boolean } | number) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (!String(input).endsWith("/reload/status")) throw new Error(`unexpected fetch ${String(input)}`);
    if (typeof answer === "number") return new Response("", { status: answer });
    return new Response(JSON.stringify({ lease: { active: answer.active } }), { status: 200 });
  });
}

beforeEach(() => resetLlmLeaseCache());
afterEach(() => {
  vi.restoreAllMocks();
  resetLlmLeaseCache();
});

describe("llmBudgetMs", () => {
  it("keeps the caller's budget while the GPU is home", async () => {
    reloadStatus({ active: false });
    expect(await llmBudgetMs(8_000)).toBe(8_000);
  });

  it("waits at least as long as the server works while the GPU is lent", async () => {
    // Without an activated configuration the server's limit is its default.
    reloadStatus({ active: true });
    expect(await llmBudgetMs(120_000)).toBeGreaterThanOrEqual(900_000);
  });

  it("never shortens a budget that is already longer than the server's", async () => {
    reloadStatus({ active: true });
    expect(await llmBudgetMs(86_400_000)).toBe(86_400_000);
  });

  it("treats an llm-service that does not answer as not lent", async () => {
    reloadStatus(503);
    expect(await isGpuLent()).toBe(false);
    resetLlmLeaseCache();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await llmBudgetMs(8_000)).toBe(8_000);
  });

  it("asks the service once, not per call", async () => {
    const fetchSpy = reloadStatus({ active: true });
    await isGpuLent();
    await llmBudgetMs(1_000);
    await isGpuLent();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
