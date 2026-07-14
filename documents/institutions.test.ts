import { describe, it, expect } from "vitest";
import { INSTITUTIONS } from "./institutions";
import { SENDER_RULES, normalizeForMatch } from "./sender-rules";

describe("INSTITUTIONS", () => {
  it("has unique, filesystem-safe correspondent slugs", () => {
    const seen = new Set<string>();
    for (const inst of INSTITUTIONS) {
      expect(inst.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(seen.has(inst.slug), `duplicate slug: ${inst.slug}`).toBe(false);
      seen.add(inst.slug);
    }
  });

  it("has non-empty, pre-normalised fragments and a display for every entry", () => {
    for (const inst of INSTITUTIONS) {
      expect(inst.display.length).toBeGreaterThan(0);
      expect(inst.fragments.length).toBeGreaterThan(0);
      for (const frag of inst.fragments) {
        expect(frag, `fragment not normalised: ${frag}`).toBe(normalizeForMatch(frag));
      }
    }
  });

  // The single-source guard: an institution must only name sender fragments the
  // routing table already knows. This keeps correspondents grounded in the
  // curated senders and fails loudly if the two lists drift apart.
  it("only names sender fragments that exist in SENDER_RULES", () => {
    const knownSenders = new Set(SENDER_RULES.flatMap((r) => r.senders));
    for (const inst of INSTITUTIONS) {
      for (const frag of inst.fragments) {
        expect(
          knownSenders.has(frag),
          `institution "${inst.slug}" names fragment "${frag}" that no sender rule knows`,
        ).toBe(true);
      }
    }
  });
});
