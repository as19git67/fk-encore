import { describe, it, expect } from "vitest";

import { CLASSIFY_PROMPTS } from "./classify-prompts";
import { categoryTaxonomy } from "./taxonomy";

/**
 * Every character of prompt scaffolding is a character the document does not
 * get to use.
 *
 * The llm-service budgets each classify request as `n_ctx` minus a response
 * reserve minus the assembled prompt, and truncates the document text to
 * whatever is left (`classify: truncated document text to fit n_ctx`). The
 * scaffolding — taxonomy hints plus the five prompt constants — is by far the
 * larger side of that split, so growing it silently shrinks how much of a
 * document the classifier ever reads.
 *
 * That is not hypothetical. Adding the category rules and some hint detail
 * pushed a production instance from roughly 2500 usable document tokens down
 * to 1474 — a 40 % cut that nothing in the test suite noticed, because no test
 * connected prompt length to document budget. This one does.
 *
 * When this fails, the choice is deliberate: either the addition is worth less
 * document context, or something else here has to shrink first. Do not simply
 * raise the ceiling without deciding which.
 */
const SCAFFOLDING_CHAR_CEILING = 41_000;

function hintChars(): number {
  let total = 0;
  const walk = (nodes: typeof categoryTaxonomy) => {
    for (const n of nodes) {
      if (n.hint) total += n.hint.length;
      if (n.children?.length) walk(n.children);
    }
  };
  walk(categoryTaxonomy);
  return total;
}

function promptChars(): number {
  return Object.values(CLASSIFY_PROMPTS).reduce((sum, p) => sum + p.length, 0);
}

describe("classifier prompt budget", () => {
  it("keeps the scaffolding under the ceiling that leaves room for the document", () => {
    const hints = hintChars();
    const prompts = promptChars();
    const total = hints + prompts;

    // German averages roughly 3.2 characters per token, so the estimate is a
    // guide rather than a measurement — the service does the real tokenising.
    const detail =
      `taxonomy hints ${hints} + prompt constants ${prompts} = ${total} chars ` +
      `(~${Math.round(total / 3.2)} tokens). Ceiling ${SCAFFOLDING_CHAR_CEILING}.`;

    expect(total, detail).toBeLessThanOrEqual(SCAFFOLDING_CHAR_CEILING);
  });

  it("keeps the hints from dwarfing the slugs they disambiguate", () => {
    // Hints cost several times what the slug + name list costs. A hint earns
    // its place by resolving a confusion that actually happens; prose that
    // merely restates the category name does not.
    let slugNameChars = 0;
    const walk = (nodes: typeof categoryTaxonomy) => {
      for (const n of nodes) {
        slugNameChars += n.slug.length + n.name.length;
        if (n.children?.length) walk(n.children);
      }
    };
    walk(categoryTaxonomy);

    const ratio = hintChars() / slugNameChars;
    expect(ratio, `hints are ${ratio.toFixed(1)}x the slug+name list`).toBeLessThan(6);
  });
});
