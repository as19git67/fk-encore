import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * classifyDocument must push the current prompts to the llm-service once per
 * process before its first classify, so a prompt edit takes effect on a plain
 * app redeploy instead of silently waiting for the (prompt-caching) service to
 * restart. See the `ensurePromptsFresh` rationale in llm-client.ts.
 */

interface Call {
  method: string;
  url: string;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const CLASSIFY_OK = {
  category_slug: "finanzen",
  title: "t",
  summary: "s",
  tags: [],
  confidence: 0.9,
};

describe("classifyDocument — one-time prompt refresh", () => {
  let calls: Call[];

  beforeEach(() => {
    vi.resetModules(); // fresh module → fresh `promptSync` state per test
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init: any) => {
        const u = String(url);
        calls.push({ method: init?.method ?? "GET", url: u });
        if (u.endsWith("/prompts")) return jsonResponse(200, { status: "ok" });
        if (u.endsWith("/classify")) return jsonResponse(200, CLASSIFY_OK);
        return jsonResponse(404, {});
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const req = { text: "x", taxonomy: [{ slug: "finanzen", name: "Finanzen", parent_slug: null }] };

  it("pushes prompts once, before the first classify, and not again on the second", async () => {
    const { classifyDocument } = await import("./llm-client");

    await classifyDocument(req as any);
    await classifyDocument(req as any);

    const puts = calls.filter((c) => c.method === "PUT" && c.url.endsWith("/prompts"));
    const posts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/classify"));

    expect(puts).toHaveLength(1); // once per process, not per classify
    expect(posts).toHaveLength(2);
    expect(calls[0].method).toBe("PUT"); // refresh happens before the first classify
    expect(calls[0].url.endsWith("/prompts")).toBe(true);
  });

  it("still classifies when the prompt refresh fails (best-effort)", async () => {
    vi.resetModules();
    calls = [];
    let firstPromptsCall = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init: any) => {
        const u = String(url);
        calls.push({ method: init?.method ?? "GET", url: u });
        if (u.endsWith("/prompts")) {
          // The refresh PUT fails transiently; the classify must still proceed.
          if (firstPromptsCall) {
            firstPromptsCall = false;
            return jsonResponse(503, { detail: "loading" });
          }
          return jsonResponse(200, { status: "ok" });
        }
        return jsonResponse(200, CLASSIFY_OK);
      }),
    );

    const { classifyDocument } = await import("./llm-client");
    const result = await classifyDocument(req as any);

    expect(result.category_slug).toBe("finanzen");
    // The classify POST still happened despite the failed refresh.
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/classify"))).toBe(true);
  });
});
