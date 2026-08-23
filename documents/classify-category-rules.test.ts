import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLASSIFY_CATEGORY_RULES,
  CLASSIFY_PROMPTS,
} from "./classify-prompts";
import { categoryTaxonomy, taxonomyHints } from "./taxonomy";

/**
 * The category rules are shared with the cloud audit: `cloud_audit.py` pulls
 * CLASSIFY_CATEGORY_RULES out of this file with a backtick-delimited regex so
 * the reference model and the local classifier are given identical guidance.
 * Both halves of that arrangement break silently — a stray backtick truncates
 * the extracted text, and a rename makes the loader raise at import time — so
 * they are pinned here.
 */
describe("CLASSIFY_CATEGORY_RULES", () => {
  it("is reachable by the Python loader's regex", () => {
    const source = readFileSync(
      join(import.meta.dirname, "classify-prompts.ts"),
      "utf8",
    );
    // Mirrors _load_prompt_constant() in scripts/taxonomy/cloud_audit.py.
    const match = source.match(/CLASSIFY_CATEGORY_RULES\s*=\s*`(.*?)`/s);
    expect(match).not.toBeNull();
    expect(match![1].trim()).toBe(CLASSIFY_CATEGORY_RULES.trim());
  });

  it("contains no backtick, which would truncate that extraction", () => {
    expect(CLASSIFY_CATEGORY_RULES).not.toContain("`");
  });

  it("is actually sent to the llm-service", () => {
    expect(CLASSIFY_PROMPTS.classify_system).toContain(CLASSIFY_CATEGORY_RULES);
  });

  it("names only slugs that exist in the taxonomy", () => {
    const known = new Set<string>();
    const walk = (nodes: typeof categoryTaxonomy) => {
      for (const n of nodes) {
        known.add(n.slug);
        if (n.children?.length) walk(n.children);
      }
    };
    walk(categoryTaxonomy);

    // Every slug-shaped token the rules use as an example must be real,
    // otherwise the guidance points the model at a label it cannot pick.
    const referenced = CLASSIFY_CATEGORY_RULES.match(/\b[a-z]+(?:-[a-z]+)+\b/g) ?? [];
    const unknown = [...new Set(referenced)].filter((s) => !known.has(s));
    expect(unknown).toEqual([]);
  });
});

describe("catch-all category hints", () => {
  it("gives finanzen-rechnungen a positive criterion, not only exclusions", () => {
    const hint = taxonomyHints().get("finanzen-rechnungen")!;
    // The old hint opened with "Sammelkategorie — NUR wählen, wenn …" and
    // listed nothing but exclusions, leaving it indistinguishable from
    // "sonstiges"; both local models resolved the ambiguity towards sonstiges.
    expect(hint).toMatch(/Rechnungen, Kaufbelege/);
    expect(hint).toContain("NICHT nach sonstiges");
  });

  it("keeps parent categories from advertising their children's scope", () => {
    const hint = taxonomyHints().get("landwirtschaft")!;
    expect(hint).toContain("NICHT direkt wählen");
    for (const child of [
      "landwirtschaft-pacht",
      "landwirtschaft-versicherung",
      "landwirtschaft-instandhaltung",
      "landwirtschaft-steuer",
    ]) {
      expect(hint).toContain(child);
    }
  });
});

/**
 * Boundaries the 2026-08-23 scoreboard showed both local models failing at or
 * near 100 %. Each was a definition problem rather than a model one, so the
 * settled definition is pinned here.
 */
describe("category boundaries settled after the scoreboard", () => {
  const hints = taxonomyHints();

  it("routes ongoing employer correspondence away from the contract category", () => {
    // The old hint listed "Urlaubsanträge" under beruf-arbeitsvertrag, so the
    // reference model was following it correctly while both local models put
    // such documents in beruf-betriebliche-unterlagen. That reading won.
    const contract = hints.get("beruf-arbeitsvertrag")!;
    // It may still name the document — but only to send it elsewhere, so the
    // mention has to sit after the NICHT clause, not in the positive list.
    expect(contract.indexOf("NICHT")).toBeLessThan(contract.indexOf("Urlaubsantrag"));
    expect(contract).toContain("beruf-betriebliche-unterlagen");
    expect(hints.get("beruf-betriebliche-unterlagen")!).toMatch(/Urlaubsantrag/);
  });

  it("covers the whole acquisition in wohnen-haus-kaufvertrag", () => {
    const hint = hints.get("wohnen-haus-kaufvertrag")!;
    for (const probe of ["Eintragungsbekanntmachung", "Vermessung", "gutachten"]) {
      expect(hint).toContain(probe);
    }
    // Same paperwork for a let property belongs to the other branch; the
    // reference labelled two identical Grundbuch documents differently.
    expect(hint).toContain("kapitalanlage-immobilie-kaufvertrag");
  });

  it("says belege is assigned by receipt capture, not by the classifier", () => {
    expect(hints.get("belege")!).toMatch(/nicht vom Klassifikator vergeben/i);
  });
});
