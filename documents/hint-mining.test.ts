import { describe, it, expect } from "vitest";
import {
  topKeywords,
  buildConfusionPairs,
  topSenders,
  buildDraftHint,
  type TfIdfEntry,
  type ConfusionPair,
  type SenderFrequency,
} from "./hint-mining";

describe("topKeywords (TF-IDF)", () => {
  it("returns empty for empty input", () => {
    expect(topKeywords([], [], 5)).toEqual([]);
    expect(topKeywords(["foo bar"], [], 5)).toEqual([]);
    expect(topKeywords([], ["foo bar"], 5)).toEqual([]);
  });

  it("extracts keywords that are distinctive to the corpus", () => {
    const corpusTexts = [
      "Versicherung Haftpflicht Vertrag",
      "Haftpflicht Versicherung Police",
      "Versicherung Schaden Haftpflicht melden",
    ];
    const allTexts = [
      ...corpusTexts,
      "Rechnung Strom Stadtwerke Abschlag",
      "Gehalt Abrechnung Lohn Monat",
      "Mietvertrag Wohnung Kaution",
      "Steuererklärung Finanzamt Bescheid",
    ];

    const result = topKeywords(corpusTexts, allTexts, 3);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(3);
    const terms = result.map((e) => e.term);
    expect(terms).toContain("haftpflicht");
    expect(terms).toContain("versicherung");
    for (const entry of result) {
      expect(entry.tfidf).toBeGreaterThan(0);
    }
  });

  it("filters stop words and short tokens", () => {
    const texts = ["der die das und oder"];
    const result = topKeywords(texts, texts, 10);
    expect(result).toEqual([]);
  });

  it("respects maxN limit", () => {
    const texts = ["alpha bravo charlie delta echo foxtrot"];
    const result = topKeywords(texts, texts, 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });
});

describe("buildConfusionPairs", () => {
  it("returns empty for no mismatches", () => {
    const rows = [
      { id: 1, sender: "A", ai_category_slug: "kat-a", reviewed_category_slug: "kat-a" },
      { id: 2, sender: "B", ai_category_slug: "kat-b", reviewed_category_slug: "kat-b" },
    ];
    expect(buildConfusionPairs(rows)).toEqual([]);
  });

  it("ignores single occurrences (requires count >= 2)", () => {
    const rows = [
      { id: 1, sender: "A", ai_category_slug: "kat-a", reviewed_category_slug: "kat-b" },
    ];
    expect(buildConfusionPairs(rows)).toEqual([]);
  });

  it("groups repeated misclassifications", () => {
    const rows = [
      { id: 1, sender: "A", ai_category_slug: "finanzen", reviewed_category_slug: "versicherung" },
      { id: 2, sender: "B", ai_category_slug: "finanzen", reviewed_category_slug: "versicherung" },
      { id: 3, sender: "C", ai_category_slug: "finanzen", reviewed_category_slug: "versicherung" },
    ];
    const pairs = buildConfusionPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].ai_slug).toBe("finanzen");
    expect(pairs[0].reviewed_slug).toBe("versicherung");
    expect(pairs[0].count).toBe(3);
    expect(pairs[0].example_ids).toEqual([1, 2, 3]);
  });

  it("sorts by count descending", () => {
    const rows = [
      { id: 1, sender: null, ai_category_slug: "a", reviewed_category_slug: "b" },
      { id: 2, sender: null, ai_category_slug: "a", reviewed_category_slug: "b" },
      { id: 3, sender: null, ai_category_slug: "x", reviewed_category_slug: "y" },
      { id: 4, sender: null, ai_category_slug: "x", reviewed_category_slug: "y" },
      { id: 5, sender: null, ai_category_slug: "x", reviewed_category_slug: "y" },
    ];
    const pairs = buildConfusionPairs(rows);
    expect(pairs.length).toBe(2);
    expect(pairs[0].ai_slug).toBe("x");
    expect(pairs[0].count).toBe(3);
    expect(pairs[1].ai_slug).toBe("a");
    expect(pairs[1].count).toBe(2);
  });

  it("skips rows with null/empty slugs", () => {
    const rows = [
      { id: 1, sender: null, ai_category_slug: null, reviewed_category_slug: "kat" },
      { id: 2, sender: null, ai_category_slug: "kat", reviewed_category_slug: null },
      { id: 3, sender: null, ai_category_slug: "", reviewed_category_slug: "kat" },
    ];
    expect(buildConfusionPairs(rows)).toEqual([]);
  });
});

describe("topSenders", () => {
  it("returns empty for no senders", () => {
    expect(topSenders([], 5)).toEqual([]);
    expect(topSenders([{ sender: null }, { sender: "" }], 5)).toEqual([]);
  });

  it("counts and sorts senders", () => {
    const rows = [
      { sender: "ADAC" },
      { sender: "ADAC" },
      { sender: "ADAC" },
      { sender: "Allianz" },
      { sender: "Allianz" },
      { sender: "Barmer" },
    ];
    const result = topSenders(rows, 10);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ sender: "ADAC", count: 3 });
    expect(result[1]).toEqual({ sender: "Allianz", count: 2 });
    expect(result[2]).toEqual({ sender: "Barmer", count: 1 });
  });

  it("respects maxN", () => {
    const rows = [
      { sender: "A" }, { sender: "A" },
      { sender: "B" }, { sender: "B" },
      { sender: "C" },
    ];
    const result = topSenders(rows, 2);
    expect(result).toHaveLength(2);
  });

  it("trims whitespace before counting", () => {
    const rows = [
      { sender: "  ADAC  " },
      { sender: "ADAC" },
    ];
    const result = topSenders(rows, 5);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ sender: "ADAC", count: 2 });
  });
});

describe("buildDraftHint", () => {
  it("returns empty when no senders or keywords", () => {
    expect(
      buildDraftHint({ sectionName: "test", senders: [], keywords: [] }),
    ).toBe("");
  });

  it("includes senders only", () => {
    const hint = buildDraftHint({
      sectionName: "Anlage V",
      senders: [
        { sender: "Finanzamt", count: 10 },
        { sender: "Steuerkanzlei", count: 5 },
      ],
      keywords: [],
    });
    expect(hint).toBe("Typische Absender: Finanzamt, Steuerkanzlei.");
  });

  it("includes keywords only", () => {
    const hint = buildDraftHint({
      sectionName: "Anlage V",
      senders: [],
      keywords: [
        { term: "miete", tfidf: 0.5 },
        { term: "nebenkosten", tfidf: 0.3 },
      ],
    });
    expect(hint).toBe("Schlüsselwörter: miete, nebenkosten.");
  });

  it("combines senders and keywords", () => {
    const hint = buildDraftHint({
      sectionName: "Anlage V",
      senders: [{ sender: "Vermieter", count: 8 }],
      keywords: [{ term: "miete", tfidf: 0.5 }],
    });
    expect(hint).toBe("Typische Absender: Vermieter. Schlüsselwörter: miete.");
  });
});
