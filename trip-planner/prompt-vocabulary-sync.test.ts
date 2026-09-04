/**
 * The prompt must offer every category the search accepts.
 *
 * The vocabulary lives once, in `geo/src/poi-categories.ts`, and
 * reaches the language model through `buildInterpretPrompt`. Nothing
 * fails loudly if a category is added there and never makes it into the
 * prompt: the search would still accept it, the model would simply
 * never propose it, and "Cafés werden nie vorgeschlagen" is not a bug
 * report anyone connects back to a missing prompt line.
 *
 * The prompt is built from the vocabulary at runtime (the endpoint
 * fetches it from geo), so this test checks the wiring rather than a
 * hand-kept list: every category id in the geo source must survive into
 * the rendered prompt, and the model must be told not to invent others.
 *
 * Reads geo from disk for the same reason poi-tag-sync.test.ts does:
 * geo is a standalone package and cannot be imported from here.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInterpretPrompt } from "./llm-client";

const repoRoot = path.resolve(__dirname, "..");
const categoriesSource = readFileSync(
  path.join(repoRoot, "geo/src/poi-categories.ts"),
  "utf8",
);

/** Category ids as written in the geo source, e.g. `id: "food",`. */
function categoryIdsFromGeo(): string[] {
  const ids = [...categoriesSource.matchAll(/^\s*id:\s*"([a-z_]+)"/gm)].map((m) => m[1]);
  expect(ids.length).toBeGreaterThan(0);
  return ids;
}

describe("the interpretation prompt and the search vocabulary", () => {
  it("offers every category geo defines", () => {
    const ids = categoryIdsFromGeo();
    const prompt = buildInterpretPrompt(
      "Vier Tage Augsburg",
      ids.map((id) => ({ id, description: `desc for ${id}` })),
    );
    for (const id of ids) {
      expect(prompt, `category '${id}' never reaches the model`).toContain(id);
    }
  });

  it("carries each category's description, not just its id", () => {
    // The ids are terse ("essentials"); without the description the
    // model has to guess what belongs in one.
    const prompt = buildInterpretPrompt("Ein Tag", [
      { id: "essentials", description: "pharmacy, toilets, water, cash, groceries" },
    ]);
    expect(prompt).toContain("pharmacy, toilets, water, cash, groceries");
  });

  it("tells the model not to invent categories", () => {
    const prompt = buildInterpretPrompt("Ein Tag", [{ id: "food", description: "eat" }]);
    expect(prompt).toMatch(/erfinde keine kategorie/i);
  });

  it("includes the traveller's sentence verbatim", () => {
    const text = "Wir sind vier Tage in Augsburg, mit einem Kind, eher gemütlich";
    expect(buildInterpretPrompt(text, [])).toContain(text);
  });
});
