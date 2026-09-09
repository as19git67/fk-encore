import { describe, it, expect } from "vitest";
import {
  buildCollectionSummaryPrompt,
  parseCollectionSummary,
  type CollectionSummaryMember,
} from "./collection-summary";

function member(overrides: Partial<CollectionSummaryMember> = {}): CollectionSummaryMember {
  return {
    title: "Lohnsteuerbescheinigung 2024",
    sender: "Beispiel GmbH",
    doc_date: "2025-01-31",
    category_name: "Steuer",
    summary: "Jahresbescheinigung über einbehaltene Lohnsteuer.",
    ...overrides,
  };
}

describe("buildCollectionSummaryPrompt", () => {
  it("carries every field the model is meant to read", () => {
    const prompt = buildCollectionSummaryPrompt({
      title: "Steuer 2024",
      notes: "Für den Steuerberater",
      members: [member()],
    });
    expect(prompt).toContain("Steuer 2024");
    expect(prompt).toContain("Für den Steuerberater");
    expect(prompt).toContain("Lohnsteuerbescheinigung 2024");
    expect(prompt).toContain("Beispiel GmbH");
    expect(prompt).toContain("2025-01-31");
    expect(prompt).toContain("Jahresbescheinigung über einbehaltene Lohnsteuer.");
    expect(prompt).toContain("Anzahl Dokumente: 1");
  });

  it("numbers the documents in the order they were given", () => {
    const prompt = buildCollectionSummaryPrompt({
      title: "Mappe",
      notes: null,
      members: [member({ title: "Erstes" }), member({ title: "Zweites" })],
    });
    expect(prompt.indexOf("1. Erstes")).toBeGreaterThan(-1);
    expect(prompt.indexOf("2. Zweites")).toBeGreaterThan(prompt.indexOf("1. Erstes"));
  });

  it("names a document without metadata rather than dropping it", () => {
    const prompt = buildCollectionSummaryPrompt({
      title: "Mappe",
      notes: null,
      members: [member({ title: null, sender: null, doc_date: null, category_name: null, summary: null })],
    });
    expect(prompt).toContain("1. (ohne Titel)");
  });

  it("counts the documents it did not list", () => {
    const members = Array.from({ length: 45 }, (_, i) => member({ title: `Dokument ${i + 1}` }));
    const prompt = buildCollectionSummaryPrompt({ title: "Groß", notes: null, members });
    expect(prompt).toContain("Anzahl Dokumente: 45");
    expect(prompt).toContain("Dokument 40");
    expect(prompt).not.toContain("Dokument 41");
    expect(prompt).toContain("und 5 weitere Dokumente");
  });

  it("collapses a long per-document summary instead of pasting it whole", () => {
    const long = `${"a".repeat(900)}`;
    const prompt = buildCollectionSummaryPrompt({
      title: "Mappe",
      notes: null,
      members: [member({ summary: long })],
    });
    expect(prompt).not.toContain(long);
    expect(prompt).toContain("a".repeat(400));
  });
});

describe("parseCollectionSummary", () => {
  it("takes the summary field", () => {
    expect(parseCollectionSummary({ summary: "  Kurz und knapp.  " })).toBe("Kurz und knapp.");
  });

  it("rejects a response without usable text", () => {
    expect(() => parseCollectionSummary({ summary: "   " })).toThrow(/no summary text/);
    expect(() => parseCollectionSummary({})).toThrow(/no summary text/);
    expect(() => parseCollectionSummary("Kurz und knapp.")).toThrow(/non-object/);
    expect(() => parseCollectionSummary(null)).toThrow(/non-object/);
  });
});
