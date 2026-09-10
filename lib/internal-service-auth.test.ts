// The outbound half of the internal-service authentication.
//
// The five Python services now refuse a request without a bearer token.
// Attaching it is keyed on the destination rather than spread across the
// ~30 call sites in sixteen client modules — a missed call site would be a
// feature that 401s in production and nowhere else, since no test exercises
// the real services. These pin that the rule fires on exactly the right
// requests and leaves everything else alone.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const SECRET = "test-internal-secret";

/** Records what the wrapped fetch was ultimately called with. */
let calls: Array<{ url: string; headers: Headers }>;
let originalFetch: typeof globalThis.fetch;

async function loadWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(key, "");
    else vi.stubEnv(key, value);
  }

  const spy = vi.fn(async (input: any, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : String(input),
      headers: new Headers(init?.headers),
    });
    return new Response("ok");
  });
  globalThis.fetch = spy as unknown as typeof fetch;

  await import("./internal-service-auth");
}

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("with a secret configured", () => {
  const env = {
    INTERNAL_SERVICE_SECRET: SECRET,
    LLM_SERVICE_URL: "http://llm_service:8000",
    EMBEDDING_SERVICE_URL: "http://embedding_service:8000",
    INSIGHTFACE_SERVICE_URL: "http://insightface:8000",
    RECEIPT_OCR_SERVICE_URL: "http://receipt_ocr_service:8000",
    TAXONOMY_TOOLS_SERVICE_URL: "http://taxonomy_tools:8000",
  };

  it("attaches the token to each of the five services", async () => {
    await loadWithEnv(env);

    for (const base of Object.values(env).filter((v) => v.startsWith("http"))) {
      await fetch(`${base}/some/path`);
    }

    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.headers.get("authorization"), call.url).toBe(`Bearer ${SECRET}`);
    }
  });

  it("keeps the rest of the request intact", async () => {
    await loadWithEnv(env);

    await fetch("http://llm_service:8000/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });

    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
  });

  it("leaves an Authorization the caller set alone", async () => {
    await loadWithEnv(env);

    await fetch("http://llm_service:8000/x", {
      headers: { authorization: "Bearer caller-supplied" },
    });

    expect(calls[0]!.headers.get("authorization")).toBe("Bearer caller-supplied");
  });

  it("does not touch anything else", async () => {
    // The geo service has its own secret, and outbound calls to the internet
    // must never carry this one.
    await loadWithEnv(env);

    await fetch("http://geo:8080/reverse");
    await fetch("https://huggingface.co/model.gguf");

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers.get("authorization"), call.url).toBeNull();
    }
  });

  it("matches on the origin, not the exact URL", async () => {
    await loadWithEnv(env);

    await fetch("http://llm_service:8000/deep/nested/path?with=query");

    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
  });

  it("does not attach on a different port at the same host", async () => {
    await loadWithEnv(env);

    await fetch("http://llm_service:9999/x");

    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });

  it("covers the fallback URLs the clients use when unconfigured", async () => {
    // Each client falls back to a localhost port when its variable is unset.
    // A header attached to the configured URL but not the fallback would be
    // worse than either.
    await loadWithEnv({ INTERNAL_SERVICE_SECRET: SECRET });

    for (const url of [
      "http://localhost:8000/x", // insightface
      "http://localhost:8001/x", // embedding
      "http://localhost:8002/x", // llm
      "http://localhost:8003/x", // receipt-ocr
      "http://taxonomy_tools:8000/x",
    ]) {
      await fetch(url);
    }

    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.headers.get("authorization"), call.url).toBe(`Bearer ${SECRET}`);
    }
  });

  it("installs only once", async () => {
    await loadWithEnv(env);
    const afterFirst = globalThis.fetch;

    vi.resetModules();
    await import("./internal-service-auth");

    expect(globalThis.fetch).toBe(afterFirst);
  });
});

describe("without a secret configured", () => {
  it("leaves fetch untouched and says so", async () => {
    // Not fatal on purpose: the app does far more than talk to these five
    // services. The stack itself refuses to come up without the variable.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadWithEnv({ INTERNAL_SERVICE_SECRET: undefined });

    await fetch("http://localhost:8002/x");

    expect(calls[0]!.headers.get("authorization")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("INTERNAL_SERVICE_SECRET"));
    warn.mockRestore();
  });
});
