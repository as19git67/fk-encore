import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLASSIFY_CATEGORY_RULES,
  CLASSIFY_PROMPTS,
  CLASSIFY_TAX_PROMPT,
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
/**
 * Mirrors _load_prompt_constant() in scripts/taxonomy/cloud_audit.py: read the
 * constant back out of the source the way the Python loader does, and undo the
 * template-literal escapes.
 *
 * Getting this wrong is silent and expensive. The loader used to stop at the
 * first backtick of any kind (`(.*?)`), so CLASSIFY_TAX_PROMPT — which quotes
 * field names as \`relation_kind\` — reached the audit truncated at 5303 of
 * 14440 characters. Claude was judging tax relevance without the PERSONENBEZUG
 * section or any of the eight ABGRENZUNGSREGELN while the local model had them
 * all, so the run measured the prompt gap it exists to rule out. Comparing the
 * round trip against the real constant is the only check that catches that.
 */
function extractAsPythonDoes(name: string): string {
  const source = readFileSync(join(import.meta.dirname, "classify-prompts.ts"), "utf8");
  const match = source.match(new RegExp(`${name}\\s*=\\s*\`((?:[^\`\\\\]|\\\\.)*)\``, "s"));
  expect(match, `${name} not found by the loader's regex`).not.toBeNull();
  return match![1]
    .replaceAll("\\`", "`")
    .replaceAll("\\$", "$")
    .replaceAll("\\\\", "\\")
    .trim();
}

describe("prompt constants shared with the cloud audit", () => {
  it("hands the Python loader the whole of CLASSIFY_CATEGORY_RULES", () => {
    expect(extractAsPythonDoes("CLASSIFY_CATEGORY_RULES")).toBe(CLASSIFY_CATEGORY_RULES.trim());
  });

  it("hands the Python loader the whole of CLASSIFY_TAX_PROMPT", () => {
    expect(extractAsPythonDoes("CLASSIFY_TAX_PROMPT")).toBe(CLASSIFY_TAX_PROMPT.trim());
  });
});

describe("CLASSIFY_CATEGORY_RULES", () => {
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

/**
 * The 2026-08-24 cloud audit rejected 33 of 125 locally tax-flagged documents.
 * 29 of them failed for one reason: the document names a tax topic but no
 * amount anybody actually paid — a prescription, an estimate, a status letter,
 * a reimbursement. The prompt had eight specific rules and nothing covering
 * that, which is also why werbungskosten-v confirmed at only 42 %.
 */
describe("CLASSIFY_TAX_PROMPT: proof of payment", () => {
  it("requires an amount the user actually bore", () => {
    expect(CLASSIFY_TAX_PROMPT).toContain("KEIN BETRAG, KEIN BELEG");
    expect(CLASSIFY_TAX_PROMPT).toMatch(/tatsächlich angefallenen, vom Nutzer getragenen Betrag/);
  });

  it("names each document kind the audit saw misfiled", () => {
    for (const probe of [
      "Verordnung", "Rezept", "Befund-", "Kostenvoranschlag", "Angebot",
      "Wirtschaftsplan", "Standmitteilung", "Erstattungs-", "Merkblatt",
    ]) {
      expect(CLASSIFY_TAX_PROMPT, `missing: ${probe}`).toContain(probe);
    }
  });

  it("keeps the §35a exception, which needs no payment proof", () => {
    // Rule 2 states a craftsman's invoice showing a §35a labour share counts on
    // its own. A blanket "no amount, no document" rule would silently revoke
    // that, so the carve-out has to sit inside the new rule.
    const rule = CLASSIFY_TAX_PROMPT.slice(CLASSIFY_TAX_PROMPT.indexOf("KEIN BETRAG, KEIN BELEG"));
    const exception = rule.slice(0, rule.indexOf("PERSONENBEZUG"));
    expect(exception).toContain("AUSNAHME");
    expect(exception).toMatch(/35a/);
  });

  it("treats a party membership fee as a deduction, but only with an amount", () => {
    // Two CSU contribution records were the audit's clearest false negatives.
    const spenden = CLASSIFY_TAX_PROMPT.slice(CLASSIFY_TAX_PROMPT.indexOf("4) Spenden"));
    expect(spenden).toMatch(/MITGLIEDSBEITRAG an eine Partei/);
    expect(spenden).toMatch(/34g/);
    expect(spenden).toContain("NICHT für Aufnahme-/Austrittsschreiben ohne Betrag");
    // Union dues are Werbungskosten, not Sonderausgaben — a neighbouring trap.
    expect(spenden).toContain("werbungskosten-n");
  });
});
