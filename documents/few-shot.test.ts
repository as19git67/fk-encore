import { describe, it, expect } from "vitest";
import { pickDiverseExamples, type NeighborRow } from "./few-shot";

function row(p: Partial<NeighborRow> & Pick<NeighborRow, "category_slug">): NeighborRow {
  return {
    category_name: p.category_slug,
    title: "Titel",
    sender: "Absender",
    dist: 0.1,
    attributes_reviewed: false,
    ...p,
  };
}

describe("pickDiverseExamples", () => {
  it("returns [] for no rows", () => {
    expect(pickDiverseExamples([])).toEqual([]);
  });

  it("keeps one example per distinct category, preserving input order", () => {
    const out = pickDiverseExamples([
      row({ category_slug: "finanzen-gehalt", title: "Gehalt Mai" }),
      row({ category_slug: "finanzen-gehalt", title: "Gehalt Juni" }),
      row({ category_slug: "wohnen-nebenkosten", title: "Nebenkosten" }),
    ]);
    expect(out.map((e) => e.category_slug)).toEqual([
      "finanzen-gehalt",
      "wohnen-nebenkosten",
    ]);
    // First occurrence wins for the deduped category.
    expect(out[0].title).toBe("Gehalt Mai");
  });

  it("caps the result at maxExamples", () => {
    const rows = ["a", "b", "c", "d", "e", "f", "g"].map((s) => row({ category_slug: s }));
    expect(pickDiverseExamples(rows, 3)).toHaveLength(3);
  });

  it("normalises slug to lowercase and dedups case-insensitively", () => {
    const out = pickDiverseExamples([
      row({ category_slug: "Finanzen-Gehalt", title: "A" }),
      row({ category_slug: "finanzen-gehalt", title: "B" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].category_slug).toBe("finanzen-gehalt");
  });

  it("skips rows without a usable title or slug", () => {
    const out = pickDiverseExamples([
      row({ category_slug: "", title: "kein slug" }),
      row({ category_slug: "ok", title: "   " }),
      row({ category_slug: "good", title: "Brauchbar" }),
    ]);
    expect(out.map((e) => e.category_slug)).toEqual(["good"]);
  });

  it("collapses a blank sender to null", () => {
    const out = pickDiverseExamples([row({ category_slug: "x", sender: "   " })]);
    expect(out[0].sender).toBeNull();
  });
});
