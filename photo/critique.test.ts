import { describe, expect, it, vi } from "vitest";
import {
  CritiqueUnavailableError,
  buildCritiquePrompt,
  parseCritique,
  requestCritique,
  scoreBand,
  writeCritique,
  type CritiqueDeps,
} from "./critique";

function deps(overrides: Partial<CritiqueDeps> = {}): CritiqueDeps {
  return {
    isGpuLent: async () => false,
    image: async () => Buffer.from("jpeg"),
    scores: async () => ({ aesthetics: 0.72, quality: 0.4 }),
    ask: async () => ({
      result: {
        summary: "Weiches Abendlicht trägt das Bild.",
        strengths: ["Warmes Licht"],
        weaknesses: ["Horizont leicht schief"],
      },
      model: "gemma-test.gguf",
    }),
    save: async (c) => ({ ...c, created_at: "2026-10-21T12:00:00Z" }),
    ...overrides,
  };
}

describe("scoreBand", () => {
  it("turns a 0–1 score into a word", () => {
    expect(scoreBand(0.2)).toBe("schwach");
    expect(scoreBand(0.55)).toBe("mittel");
    expect(scoreBand(0.9)).toBe("sehr gut");
    expect(scoreBand(null)).toBeNull();
  });
});

describe("buildCritiquePrompt", () => {
  it("hands the model the scores as words, never as numbers", () => {
    const { prompt, system } = buildCritiquePrompt({ aesthetics: 0.72, quality: 0.4 });
    expect(prompt).toContain("„gut“");
    expect(prompt).toContain("„eher schwach“");
    expect(prompt).not.toMatch(/0[.,]\d/);
    expect(system).toMatch(/keine Noten/);
  });

  it("asks without a judgement to explain when the photo has no score", () => {
    const { prompt } = buildCritiquePrompt({ aesthetics: null, quality: null });
    expect(prompt).not.toContain("Ästhetikmodell");
    expect(prompt).not.toContain("Einschätzung");
  });
});

describe("parseCritique", () => {
  it("keeps summary and points, trimmed", () => {
    expect(parseCritique({ summary: " Ruhig. ", strengths: ["- Licht ", "Licht"], weaknesses: [] })).toEqual({
      summary: "Ruhig.",
      strengths: ["Licht"],
      weaknesses: [],
    });
  });

  it("drops every line that grades the photo", () => {
    const parsed = parseCritique({
      summary: "Ein stimmungsvolles Bild. Ich gebe 8/10. Insgesamt 85 % gelungen.",
      strengths: ["Klare Farben", "4 von 5 Sternen"],
      weaknesses: ["Note 3 für die Schärfe", "Etwas unruhiger Hintergrund"],
    });
    expect(parsed).toEqual({
      summary: "Ein stimmungsvolles Bild.",
      strengths: ["Klare Farben"],
      weaknesses: ["Etwas unruhiger Hintergrund"],
    });
  });

  it("bounds the number of points", () => {
    const parsed = parseCritique({ summary: "x.", strengths: ["a", "b", "c", "d", "e", "f"], weaknesses: [] });
    expect(parsed?.strengths).toHaveLength(4);
  });

  it("is null for an answer with nothing usable", () => {
    expect(parseCritique({ summary: "", strengths: [], weaknesses: [] })).toBeNull();
    expect(parseCritique("text")).toBeNull();
    expect(parseCritique(null)).toBeNull();
  });
});

describe("writeCritique", () => {
  it("saves what the model said about the photo", async () => {
    const save = vi.fn(async (c) => ({ ...c, created_at: "t" }));
    const critique = await writeCritique(7, deps({ save }));
    expect(critique.summary).toBe("Weiches Abendlicht trägt das Bild.");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ photo_id: 7, model: "gemma-test.gguf" }));
  });

  it("does not ask the CPU twin while the GPU is lent", async () => {
    const ask = vi.fn();
    await expect(writeCritique(7, deps({ isGpuLent: async () => true, ask }))).rejects.toMatchObject({
      reason: "gpu_lent",
    });
    expect(ask).not.toHaveBeenCalled();
  });

  it("refuses a photo whose file is gone", async () => {
    await expect(writeCritique(7, deps({ image: async () => null }))).rejects.toBeInstanceOf(CritiqueUnavailableError);
  });

  it("stores nothing when the answer is unusable", async () => {
    const save = vi.fn();
    await expect(
      writeCritique(7, deps({ ask: async () => ({ result: { summary: "8/10." }, model: "m" }), save })),
    ).rejects.toMatchObject({ reason: "model" });
    expect(save).not.toHaveBeenCalled();
  });
});

describe("requestCritique", () => {
  it("asks once for two clicks on the same photo", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ask = vi.fn(async () => {
      await gate;
      return { result: { summary: "Gut belichtet.", strengths: [], weaknesses: [] }, model: "m" };
    });
    const d = deps({ ask });
    const a = requestCritique(11, d);
    const b = requestCritique(11, d);
    release();
    await Promise.all([a, b]);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
