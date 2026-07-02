import { describe, it, expect } from "vitest";
import {
  buildLearnedMemory,
  learnedRelationTags,
  LEARNED_TAX_CONFIDENCE,
  mergeLearnedPersonIds,
  mergeLearnedTags,
  mergeLearnedTaxSections,
  resolveLearned,
  type SenderMemoryEntry,
} from "./learned-rules";

describe("buildLearnedMemory — category", () => {
  it("learns the dominant category once support and share thresholds are met", () => {
    const mem = buildLearnedMemory({
      categories: [
        { sender: "Comdirect", category_slug: "finanzen-wertpapiere" },
        { sender: "comdirect", category_slug: "finanzen-wertpapiere" },
        { sender: "COMDIRECT", category_slug: "finanzen-wertpapiere" },
      ],
      taxSections: [],
      tags: [],
      persons: [],
    });
    // Matching is per normalized sender string (case/punctuation-insensitive),
    // so the three spelling variants collapse to one key.
    const e = resolveLearned(mem, "Comdirect!");
    expect(e?.category?.slug).toBe("finanzen-wertpapiere");
    expect(e?.category?.support).toBe(3);
    expect(e?.category?.share).toBe(1);
  });

  it("does not learn a category below the minimum support (3)", () => {
    const mem = buildLearnedMemory({
      categories: [
        { sender: "Acme", category_slug: "finanzen-rechnungen" },
        { sender: "Acme", category_slug: "finanzen-rechnungen" },
      ],
      taxSections: [],
      tags: [],
      persons: [],
    });
    expect(resolveLearned(mem, "Acme")?.category ?? null).toBeNull();
  });

  it("does not learn a category when no slug dominates (share < 0.75)", () => {
    const mem = buildLearnedMemory({
      categories: [
        { sender: "Mixed", category_slug: "a" },
        { sender: "Mixed", category_slug: "a" },
        { sender: "Mixed", category_slug: "b" },
        { sender: "Mixed", category_slug: "c" },
      ],
      taxSections: [],
      tags: [],
      persons: [],
    });
    // top share = 2/4 = 0.5 < 0.75
    expect(resolveLearned(mem, "Mixed")?.category ?? null).toBeNull();
  });

  it("ignores rows with an empty/normalizing-to-empty sender", () => {
    const mem = buildLearnedMemory({
      categories: [
        { sender: null, category_slug: "x" },
        { sender: "   ", category_slug: "x" },
        { sender: "!!!", category_slug: "x" },
      ],
      taxSections: [],
      tags: [],
      persons: [],
    });
    expect(mem.size).toBe(0);
  });
});

describe("buildLearnedMemory — tax / tags / persons", () => {
  it("keeps only valid tax slugs seen at least twice, most-frequent first", () => {
    const mem = buildLearnedMemory({
      categories: [],
      taxSections: [
        { sender: "Broker", tax_section: "anlage-kap" },
        { sender: "Broker", tax_section: "anlage-kap" },
        { sender: "Broker", tax_section: "not-a-real-section" },
        { sender: "Broker", tax_section: "not-a-real-section" },
        { sender: "Broker", tax_section: "anlage-n" }, // only once → dropped
      ],
      tags: [],
      persons: [],
    });
    expect(resolveLearned(mem, "Broker")?.taxSections).toEqual(["anlage-kap"]);
  });

  it("learns recurring user tags (>=2) and drops one-offs", () => {
    const mem = buildLearnedMemory({
      categories: [],
      taxSections: [],
      tags: [
        { sender: "Verein", tag: "mitgliedsbeitrag" },
        { sender: "Verein", tag: "mitgliedsbeitrag" },
        { sender: "Verein", tag: "einmalig" },
      ],
      persons: [],
    });
    expect(resolveLearned(mem, "Verein")?.tags).toEqual(["mitgliedsbeitrag"]);
  });

  it("learns subject persons linked at least twice for a sender", () => {
    const mem = buildLearnedMemory({
      categories: [],
      taxSections: [],
      tags: [],
      persons: [
        { sender: "Schule", subject_person_id: 7 },
        { sender: "Schule", subject_person_id: 7 },
        { sender: "Schule", subject_person_id: 9 }, // once → dropped
      ],
    });
    expect(resolveLearned(mem, "Schule")?.subjectPersonIds).toEqual([7]);
  });
});

describe("resolveLearned", () => {
  it("returns null for an empty sender", () => {
    const mem = buildLearnedMemory({ categories: [], taxSections: [], tags: [], persons: [] });
    expect(resolveLearned(mem, "")).toBeNull();
    expect(resolveLearned(mem, null)).toBeNull();
  });
});

describe("merge helpers", () => {
  const learned: SenderMemoryEntry = {
    category: null,
    taxSections: ["anlage-kap"],
    tags: ["dividende"],
    subjectPersonIds: [3, 5],
  };

  it("mergeLearnedTaxSections adds only missing valid slugs at learned confidence", () => {
    const out = mergeLearnedTaxSections([{ slug: "anlage-n", confidence: 0.9 }], learned);
    expect(out).toEqual([
      { slug: "anlage-n", confidence: 0.9 },
      { slug: "anlage-kap", confidence: LEARNED_TAX_CONFIDENCE },
    ]);
  });

  it("mergeLearnedTaxSections does not duplicate an existing slug", () => {
    const out = mergeLearnedTaxSections([{ slug: "anlage-kap", confidence: 0.4 }], learned);
    expect(out).toEqual([{ slug: "anlage-kap", confidence: 0.4 }]);
  });

  it("mergeLearnedTags appends new tags de-duplicated case-insensitively", () => {
    expect(mergeLearnedTags(["Dividende", "steuer"], learned)).toEqual(["Dividende", "steuer"]);
    expect(mergeLearnedTags(["steuer"], learned)).toEqual(["steuer", "dividende"]);
  });

  it("mergeLearnedPersonIds unions detected and learned ids", () => {
    expect(mergeLearnedPersonIds([5, 8], learned)).toEqual([5, 8, 3]);
  });

  it("learnedRelationTags maps learned ids to relation tags, skipping unknowns", () => {
    const persons = [
      { id: 3, relation_tag: "mutter" },
      { id: 5, relation_tag: "vater" },
    ];
    expect(learnedRelationTags(learned, persons)).toEqual(["mutter", "vater"]);
  });

  it("merge helpers are no-ops when learned is null", () => {
    expect(mergeLearnedTags(["a"], null)).toEqual(["a"]);
    expect(mergeLearnedTaxSections([{ slug: "anlage-n", confidence: 1 }], null)).toEqual([
      { slug: "anlage-n", confidence: 1 },
    ]);
    expect(mergeLearnedPersonIds([1], null)).toEqual([1]);
    expect(learnedRelationTags(null, [{ id: 1, relation_tag: "x" }])).toEqual([]);
  });
});
