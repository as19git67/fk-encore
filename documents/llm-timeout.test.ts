/**
 * The per-request budget for a call to the llm-service.
 *
 * It moved out of the container's environment and into the activated
 * configuration because it has to travel with the model: a MoE model with its
 * experts in system RAM is minutes per document where the dense default is
 * seconds, and a budget sized for the latter turns the former into a stream of
 * timeouts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { llmModelConfig } from "../db/schema";
import { resolveTimeoutMs, resetTimeoutCache } from "./llm-client";

// vitest.config.ts does not set LLM_SERVICE_TIMEOUT_MS, so the module-level
// fallback is llm-client's own default.
const ENV_DEFAULT_MS = 120_000;

async function insertConfig(overrides: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(llmModelConfig)
    .values({
      label: `timeout-${Math.random().toString(36).slice(2, 10)}`,
      model_filename: "m.gguf",
      ...overrides,
    })
    .returning();
  return row!;
}

beforeEach(async () => {
  await db.delete(llmModelConfig);
  resetTimeoutCache();
});

afterEach(async () => {
  await db.delete(llmModelConfig);
  resetTimeoutCache();
  vi.restoreAllMocks();
});

/** The llm-service as /reload/status reports it: GPU lent or not. */
function llmServiceLease(active: boolean) {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).endsWith("/reload/status")) {
      return new Response(JSON.stringify({ lease: { active } }), { status: 200 });
    }
    return real(input, init);
  });
}

describe("resolveTimeoutMs", () => {
  it("falls back to the environment when nothing is activated", async () => {
    // The state of every deployment that has never used the admin page.
    expect(await resolveTimeoutMs()).toBe(ENV_DEFAULT_MS);
  });

  it("uses the activated configuration's budget", async () => {
    await insertConfig({ is_active: true, app_timeout_ms: 600_000 });
    expect(await resolveTimeoutMs()).toBe(600_000);
  });

  it("ignores configurations that are not active", async () => {
    await insertConfig({ is_active: false, app_timeout_ms: 600_000 });
    expect(await resolveTimeoutMs()).toBe(ENV_DEFAULT_MS);
  });

  it("caches so a classify does not cost a query", async () => {
    const row = await insertConfig({ is_active: true, app_timeout_ms: 300_000 });
    expect(await resolveTimeoutMs()).toBe(300_000);

    await db
      .update(llmModelConfig)
      .set({ app_timeout_ms: 900_000 })
      .where(eq(llmModelConfig.id, row.id));

    // Still the cached value — a model swap takes minutes, so a stale minute
    // here costs nothing next to a query per document.
    expect(await resolveTimeoutMs()).toBe(300_000);

    resetTimeoutCache();
    expect(await resolveTimeoutMs()).toBe(900_000);
  });

  it("falls back rather than throwing when the lookup fails", async () => {
    // A database the worker cannot reach is already its own problem; it must
    // not additionally turn into a classify failure here.
    const original = db.select;
    (db as unknown as { select: unknown }).select = () => {
      throw new Error("connection terminated");
    };
    try {
      expect(await resolveTimeoutMs()).toBe(ENV_DEFAULT_MS);
    } finally {
      (db as unknown as { select: unknown }).select = original;
    }
  });

  it("waits as long as the server works while the GPU is lent to the aesthetic run", async () => {
    // The CPU twin needs minutes per document; giving up after the GPU budget
    // left llama-server busy with an abandoned request and everyone else 503.
    await insertConfig({ is_active: true, app_timeout_ms: 120_000, request_timeout_s: 1800 });
    llmServiceLease(true);
    expect(await resolveTimeoutMs()).toBe(1_800_000);
  });

  it("keeps the configured budget while the GPU is home", async () => {
    await insertConfig({ is_active: true, app_timeout_ms: 120_000, request_timeout_s: 1800 });
    llmServiceLease(false);
    expect(await resolveTimeoutMs()).toBe(120_000);
  });

  it("uses the server's default limit when lent without an activated configuration", async () => {
    llmServiceLease(true);
    expect(await resolveTimeoutMs()).toBe(900_000);
  });
});
