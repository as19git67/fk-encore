import { describe, it, expect } from "vitest";
import {
  CORRESPONDENT_REGISTRY,
  resolveCorrespondent,
} from "./correspondent";

describe("resolveCorrespondent", () => {
  it("returns null for empty, null or whitespace-only senders", () => {
    expect(resolveCorrespondent(null)).toBeNull();
    expect(resolveCorrespondent(undefined)).toBeNull();
    expect(resolveCorrespondent("")).toBeNull();
    expect(resolveCorrespondent("   ")).toBeNull();
  });

  it("returns null when the sender reduces to nothing (only punctuation)", () => {
    expect(resolveCorrespondent("!!!")).toBeNull();
    expect(resolveCorrespondent("--- / ---")).toBeNull();
  });

  it("resolves a known institution to its canonical identity", () => {
    expect(resolveCorrespondent("Janitos")).toEqual({
      slug: "janitos",
      display: "Janitos",
    });
  });

  it("matches a registry entry even with surrounding legal-form noise", () => {
    expect(resolveCorrespondent("Janitos Versicherung AG")).toEqual({
      slug: "janitos",
      display: "Janitos",
    });
  });

  it("collapses raw-sender variants of the same institution onto one slug", () => {
    const a = resolveCorrespondent("Janitos");
    const b = resolveCorrespondent("Janitos Versicherung AG");
    const c = resolveCorrespondent("JANITOS  Versicherung");
    expect(a?.slug).toBe("janitos");
    expect(b?.slug).toBe("janitos");
    expect(c?.slug).toBe("janitos");
  });

  it("is case- and punctuation-insensitive for registry matches", () => {
    expect(resolveCorrespondent("comdirect Bank")?.slug).toBe("comdirect");
    expect(resolveCorrespondent("COMDIRECT")?.slug).toBe("comdirect");
  });

  it("folds umlauts when matching a registry fragment", () => {
    // "TÜV SÜD" normalises to "tüvsüd", which is the registered fragment.
    expect(resolveCorrespondent("TÜV SÜD Auto Service GmbH")).toEqual({
      slug: "tuev-sued",
      display: "TÜV SÜD",
    });
  });

  it("unifies the employer document portals under one correspondent", () => {
    expect(resolveCorrespondent("OpenText")?.slug).toBe("arbeitgeber");
    expect(resolveCorrespondent("IXOS")?.slug).toBe("arbeitgeber");
  });

  it("unifies MLP bank and MLP life-insurance senders", () => {
    expect(resolveCorrespondent("MLP Banking AG")?.slug).toBe("mlp");
    expect(resolveCorrespondent("MLP Lebensversicherung AG")?.slug).toBe("mlp");
  });

  it("falls back to a slugified sender for unknown institutions", () => {
    expect(resolveCorrespondent("Stadtwerke Beispiel GmbH")).toEqual({
      slug: "stadtwerke-beispiel-gmbh",
      display: "Stadtwerke Beispiel GmbH",
    });
  });

  it("produces a filesystem-safe slug and trimmed display for the long tail", () => {
    expect(resolveCorrespondent("  Bäckerei Öz & Söhne  ")).toEqual({
      slug: "baeckerei-oez-soehne",
      display: "Bäckerei Öz & Söhne",
    });
  });

  it("truncates over-long fallback slugs", () => {
    const longName = "A".repeat(80);
    const out = resolveCorrespondent(longName);
    expect(out).not.toBeNull();
    expect(out!.slug.length).toBeLessThanOrEqual(40);
  });
});

describe("CORRESPONDENT_REGISTRY", () => {
  it("has only lower-case, filesystem-safe slugs", () => {
    for (const entry of CORRESPONDENT_REGISTRY) {
      expect(entry.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("has only pre-normalised fragments (no upper-case, spaces or punctuation)", () => {
    for (const entry of CORRESPONDENT_REGISTRY) {
      for (const frag of entry.fragments) {
        expect(frag).toMatch(/^[a-z0-9äöüß]+$/);
      }
    }
  });

  it("has non-empty fragments and display for every entry", () => {
    for (const entry of CORRESPONDENT_REGISTRY) {
      expect(entry.fragments.length).toBeGreaterThan(0);
      expect(entry.display.length).toBeGreaterThan(0);
    }
  });
});
