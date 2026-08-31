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

/**
 * Only the parts that are assembled into a classify request.
 *
 * `CLASSIFY_PROMPTS` is the payload of `PUT /prompts`, which also carries the
 * vision prompts for the letterhead read. Those travel over the same endpoint
 * but are stored separately in the service (`_VISION_PROMPTS`, not
 * `_CLASSIFY_PROMPTS`) and are sent with a page image on a different call, so
 * they cost the classifier's context window nothing. Counting them here would
 * charge the document budget for text no classify request ever contains, and
 * would make this ceiling fire on a change that cannot affect it.
 */
function promptChars(): number {
  return Object.entries(CLASSIFY_PROMPTS)
    .filter(([key]) => key.startsWith("classify_"))
    .reduce((sum, [, p]) => sum + p.length, 0);
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

  it("still ships the vision prompts, which simply are not part of this budget", () => {
    // The exclusion above is only correct while these exist and go somewhere
    // else. If they were dropped from the payload the service would silently
    // fall back to its compiled-in copies and prompt changes would stop taking
    // effect — with nothing failing to say so.
    expect(CLASSIFY_PROMPTS.letterhead_instruction.length).toBeGreaterThan(0);
    expect(CLASSIFY_PROMPTS.letterhead_system.length).toBeGreaterThan(0);
    expect(promptChars()).toBeLessThan(
      Object.values(CLASSIFY_PROMPTS).reduce((sum, p) => sum + p.length, 0),
    );
  });

  it("keeps the letterhead prompt generic and its exclusions ranked", () => {
    // Two properties that took a wrong answer each to learn, and that a
    // reworded prompt could quietly drop.
    const instruction = CLASSIFY_PROMPTS.letterhead_instruction;

    // Not "letter": that is the wrong question for a delivery note, which
    // answered it correctly with null while printing "Lieferdatum" twice.
    expect(instruction).toContain("delivery note");

    // The exclusions are not equally absolute. A due date belongs to something
    // else; a franking date is merely a poor answer, and on a document that
    // prints nothing better it beats an empty field.
    expect(instruction).toContain("NEVER report");
    expect(instruction).toContain("LAST RESORT");

    // The caption is what makes a fallback recognisable as one.
    expect(instruction).toContain("date_label");

    // Not "the first page": the same prompt is sent for the last page, where a
    // contract is dated beside its signature.
    expect(instruction).toContain("a page from a document");
    expect(instruction).toContain("signature");
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
