import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Spy on the embedder so we can assert the disabled path never reaches it.
// `vi.hoisted` so the spy exists before the hoisted `vi.mock` factory runs.
const { embedSpy } = vi.hoisted(() => ({
  embedSpy: vi.fn(async () => [[0.1, 0.2, 0.3]]),
}));
vi.mock("./llm-client", () => ({
  embedTexts: embedSpy,
}));

import { buildClassifyExamples } from "./few-shot";

describe("buildClassifyExamples — DOCUMENTS_FEWSHOT_ENABLED kill switch", () => {
  const prev = process.env.DOCUMENTS_FEWSHOT_ENABLED;

  beforeEach(() => {
    embedSpy.mockClear();
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.DOCUMENTS_FEWSHOT_ENABLED;
    else process.env.DOCUMENTS_FEWSHOT_ENABLED = prev;
  });

  it("is off by default — returns [] without embedding", async () => {
    delete process.env.DOCUMENTS_FEWSHOT_ENABLED;
    const out = await buildClassifyExamples({ documentId: 1, userId: 1, text: "hallo welt" });
    expect(out).toEqual([]);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("stays off for any non-'true' value", async () => {
    process.env.DOCUMENTS_FEWSHOT_ENABLED = "1";
    const out = await buildClassifyExamples({ documentId: 1, userId: 1, text: "hallo welt" });
    expect(out).toEqual([]);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("when enabled, proceeds to embed the probe text", async () => {
    process.env.DOCUMENTS_FEWSHOT_ENABLED = "true";
    // No DB rows are seeded here, so retrieval yields []; we only assert the
    // gate opened far enough to call the embedder with the e5 "query" kind.
    await buildClassifyExamples({ documentId: 1, userId: 1, text: "hallo welt" });
    expect(embedSpy).toHaveBeenCalledOnce();
    expect(embedSpy).toHaveBeenCalledWith(["hallo welt"], "query");
  });
});
