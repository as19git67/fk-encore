import { describe, it, expect } from "vitest";
import {
  CORRESPONDENT_REGISTRY,
  PRODUCT_RULES,
  buildCorrespondentFolderSlug,
  extractContractAnchor,
  resolveCorrespondent,
  resolveProductSlug,
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

  it("lets a user override win over the built-in registry", () => {
    const overrides = [{ pattern: "janitos", slug: "versicherung-x", display: "Versicherung X" }];
    expect(resolveCorrespondent("Janitos Versicherung AG", overrides)).toEqual({
      slug: "versicherung-x",
      display: "Versicherung X",
    });
  });

  it("falls back to the registry when no override pattern matches", () => {
    const overrides = [{ pattern: "allianz", slug: "allianz", display: "Allianz" }];
    expect(resolveCorrespondent("Janitos", overrides)?.slug).toBe("janitos");
  });

  it("threads overrides through buildCorrespondentFolderSlug", () => {
    const overrides = [{ pattern: "janitos", slug: "versicherung-x", display: "Versicherung X" }];
    expect(
      buildCorrespondentFolderSlug(
        { sender: "Janitos", title: "Hausratversicherung", tags: [] },
        overrides,
      ),
    ).toBe("versicherung-x-hausrat");
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

describe("resolveProductSlug", () => {
  it("returns null for empty or product-less titles", () => {
    expect(resolveProductSlug(null)).toBeNull();
    expect(resolveProductSlug("")).toBeNull();
    expect(resolveProductSlug("Beitragsrechnung 2024")).toBeNull();
  });

  it("detects a product from the title", () => {
    expect(resolveProductSlug("Privathaftpflichtversicherung Beitragsrechnung 2024"))
      .toEqual({ slug: "privathaftpflicht", display: "Privathaftpflicht" });
    expect(resolveProductSlug("Hausratversicherung Nachtrag")?.slug).toBe("hausrat");
  });

  it("prefers the more specific Kfz product over a bare match", () => {
    expect(resolveProductSlug("Kfz-Haftpflicht und Kaskoversicherung")?.slug).toBe("kfz");
  });

  it("distinguishes Zahnzusatz from general Krankenversicherung", () => {
    expect(resolveProductSlug("Zahnzusatzversicherung Beitrag")?.slug).toBe("zahnzusatz");
    expect(resolveProductSlug("Private Krankenvollversicherung")?.slug).toBe("krankenversicherung");
  });

  it("folds umlauts in product keywords", () => {
    expect(resolveProductSlug("Berufsunfähigkeitsversicherung")?.slug).toBe("berufsunfaehigkeit");
    expect(resolveProductSlug("Wohngebäudeversicherung")?.slug).toBe("wohngebaeude");
  });
});

describe("extractContractAnchor", () => {
  it("returns null when there are no contract tags", () => {
    expect(extractContractAnchor(null)).toBeNull();
    expect(extractContractAnchor([])).toBeNull();
    expect(extractContractAnchor(["kundennr:99", "auftragsnr:12345"])).toBeNull();
  });

  it("extracts a Versicherungsschein-/Vertragsnummer anchor", () => {
    expect(extractContractAnchor(["versicherungsnr:4711884"])).toBe("4711884");
    expect(extractContractAnchor(["vertragsnr:ab-12/34"])).toBe("ab-12-34");
  });

  it("prefers versicherungsnr over vertragsnr", () => {
    expect(extractContractAnchor(["vertragsnr:111", "versicherungsnr:222"])).toBe("222");
  });
});

describe("buildCorrespondentFolderSlug", () => {
  it("combines sender, product and contract anchor", () => {
    expect(
      buildCorrespondentFolderSlug({
        sender: "Janitos Versicherung AG",
        title: "Privathaftpflichtversicherung 2024",
        tags: ["versicherungsnr:4711884", "kundennr:99"],
      }),
    ).toBe("janitos-privathaftpflicht-4711884");
  });

  it("omits the contract anchor when no contract tag is present", () => {
    expect(
      buildCorrespondentFolderSlug({
        sender: "Janitos",
        title: "Hausratversicherung",
        tags: [],
      }),
    ).toBe("janitos-hausrat");
  });

  it("falls back to sender-only when neither product nor contract is known", () => {
    expect(
      buildCorrespondentFolderSlug({
        sender: "comdirect",
        title: "Depotauszug",
      }),
    ).toBe("comdirect");
  });

  it("separates two same-Sparte contracts from the same provider by anchor", () => {
    const a = buildCorrespondentFolderSlug({
      sender: "Janitos",
      title: "Privathaftpflichtversicherung",
      tags: ["versicherungsnr:111"],
    });
    const b = buildCorrespondentFolderSlug({
      sender: "Janitos",
      title: "Privathaftpflichtversicherung",
      tags: ["versicherungsnr:222"],
    });
    expect(a).toBe("janitos-privathaftpflicht-111");
    expect(b).toBe("janitos-privathaftpflicht-222");
    expect(a).not.toBe(b);
  });

  it("works with a long-tail (unregistered) sender", () => {
    expect(
      buildCorrespondentFolderSlug({
        sender: "Stadtwerke Beispiel GmbH",
        title: "Stromrechnung",
      }),
    ).toBe("stadtwerke-beispiel-gmbh");
  });

  it("returns null when there is no usable sender", () => {
    expect(
      buildCorrespondentFolderSlug({
        sender: null,
        title: "Hausratversicherung",
        tags: ["versicherungsnr:1"],
      }),
    ).toBeNull();
    expect(buildCorrespondentFolderSlug({ sender: "   " })).toBeNull();
  });
});

describe("PRODUCT_RULES", () => {
  it("has only lower-case, filesystem-safe slugs", () => {
    for (const rule of PRODUCT_RULES) {
      expect(rule.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("has only pre-normalised keywords", () => {
    for (const rule of PRODUCT_RULES) {
      for (const kw of rule.keywords) {
        expect(kw).toMatch(/^[a-z0-9äöüß]+$/);
      }
    }
  });
});
