import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";

/**
 * How long a call waits for the shared model, and how long the model itself
 * takes. The gap between them is the whole point of this file: the wait is
 * other documents' work and must not be charged to this document's allowance.
 */
const WAIT_MS = 5_000;
const MODEL_MS = 10;

/** A clock we advance ourselves, so the test costs no real seconds. */
let clock = 0;

vi.mock("../ai-queue/slot-helper", () => ({
  withAiSlot: async <T>(
    _model: string,
    _priority: number,
    _requester: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    clock += WAIT_MS; // queued behind other documents
    return fn();
  },
}));

const transcribeCrop = vi.fn(async () => {
  clock += MODEL_MS;
  return { text: "corrected", confidence: 0.95 };
});

vi.mock("./vlm-client", () => ({
  transcribeCrop: (...args: unknown[]) => transcribeCrop(...(args as [])),
  assignFields: vi.fn(),
  VlmUnavailableError: class VlmUnavailableError extends Error {},
}));

const { resolvePage } = await import("./ocr-resolver");
import type { OcrWord } from "./ocr-layout";
import type { UncertainSpan } from "./ocr-uncertainty";

let dir: string;
let pagePath: string;

function word(text: string, left: number, top: number): OcrWord {
  return { text, left, top, right: left + 120, bottom: top + 20, confidence: 12 };
}

function span(text: string, top: number): UncertainSpan {
  const w = word(text, 100, top);
  return {
    words: [w],
    bbox: { left: w.left, top: w.top, right: w.right, bottom: w.bottom },
    text,
    reasons: ["low_confidence"],
    score: 0.9,
  };
}

beforeEach(async () => {
  clock = 0;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  transcribeCrop.mockClear();
  process.env.DOCUMENTS_OCR_VLM = "1";
  process.env.DOCUMENTS_OCR_SECOND_ENGINE = "0";
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "resolver-budget-"));
  pagePath = path.join(dir, "page.png");
  await sharp({
    create: { width: 800, height: 400, channels: 3, background: "#fff" },
  })
    .png()
    .toFile(pagePath);
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.DOCUMENTS_OCR_VLM;
  delete process.env.DOCUMENTS_OCR_SECOND_ENGINE;
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe("the per-document budget under a shared model", () => {
  it("charges the model's time, not the queue in front of it", async () => {
    // The regression, and it was a real one: `started` was taken before the
    // slot was acquired, so a document waiting behind others was billed for
    // the waiting. In a 27-document batch this spent every document's whole
    // allowance on its first two or three crops and left 61% of the flagged
    // spans unexamined — logged as `ocr kept`, which reads like a decision.
    const spans = [span("aaa", 40), span("bbb", 80), span("ccc", 120)];
    const rows: OcrWord[][] = spans.map((s) => [...s.words]);

    // A budget far smaller than a single wait, but ample for three calls.
    const budget = { calls: 8, budgetMs: 1_000, spentMs: 0 };

    const result = await resolvePage({ pageImagePath: pagePath, rows, spans, vlmBudget: budget });

    expect(transcribeCrop).toHaveBeenCalledTimes(3);
    expect(budget.spentMs).toBe(3 * MODEL_MS);
    expect(result.resolved).toHaveLength(3);
  });

  it("still reports the wait, so contention stays visible", async () => {
    const spans = [span("aaa", 40), span("bbb", 80)];
    const rows: OcrWord[][] = spans.map((s) => [...s.words]);
    const budget = { calls: 8, budgetMs: 1_000, spentMs: 0 };

    const result = await resolvePage({ pageImagePath: pagePath, rows, spans, vlmBudget: budget });

    // Queue time is not silently dropped — it is reported apart from the
    // model's own time, so a slow batch reads as contention, not slow vision.
    expect(result.vlmWaitMs).toBe(2 * WAIT_MS);
    expect(result.vlmMs).toBe(2 * (WAIT_MS + MODEL_MS));
  });

  it("still stops when the model itself has used the allowance", async () => {
    const spans = [span("aaa", 40), span("bbb", 80), span("ccc", 120)];
    const rows: OcrWord[][] = spans.map((s) => [...s.words]);

    // Room for two calls' worth of model time, not three.
    const budget = { calls: 8, budgetMs: 2 * MODEL_MS, spentMs: 0 };

    await resolvePage({ pageImagePath: pagePath, rows, spans, vlmBudget: budget });

    expect(transcribeCrop).toHaveBeenCalledTimes(2);
  });

  it("still stops when the call cap is reached", async () => {
    const spans = [span("aaa", 40), span("bbb", 80), span("ccc", 120)];
    const rows: OcrWord[][] = spans.map((s) => [...s.words]);
    const budget = { calls: 1, budgetMs: 1_000, spentMs: 0 };

    await resolvePage({ pageImagePath: pagePath, rows, spans, vlmBudget: budget });

    expect(transcribeCrop).toHaveBeenCalledTimes(1);
  });
});
