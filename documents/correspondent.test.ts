import { describe, it, expect } from "vitest";
import {
  PRODUCT_RULES,
  buildCorrespondentFolderSlug,
  extractContractAnchor,
  resolveCorrespondent,
  resolveProductSlug,
  type CorrespondentOverride,
} from "./correspondent";

// The household's correspondents live in document_correspondent_overrides;
// fictional example data in the same shape.
const KNOWN: CorrespondentOverride[] = [
  { pattern: "musterversicherung", slug: "musterversicherung", display: "Musterversicherung" },
  { pattern: "beispielbank", slug: "beispielbank", display: "Beispielbank" },
  { pattern: "musterbankbanking", slug: "musterbank", display: "Musterbank" },
  { pattern: "musterbanklebensversicherung", slug: "musterbank", display: "Musterbank" },
  { pattern: "prüfstellesüd", slug: "pruefstelle-sued", display: "Prüfstelle Süd" },
];

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
    expect(resolveCorrespondent("Musterversicherung", KNOWN)).toEqual({
      slug: "musterversicherung",
      display: "Musterversicherung",
    });
  });

  it("matches an override even with surrounding legal-form noise", () => {
    expect(resolveCorrespondent("Musterversicherung Sach AG", KNOWN)).toEqual({
      slug: "musterversicherung",
      display: "Musterversicherung",
    });
  });

  it("collapses raw-sender variants of the same institution onto one slug", () => {
    const a = resolveCorrespondent("Musterversicherung", KNOWN);
    const b = resolveCorrespondent("Musterversicherung Sach AG", KNOWN);
    const c = resolveCorrespondent("MUSTERVERSICHERUNG  Sach", KNOWN);
    expect(a?.slug).toBe("musterversicherung");
    expect(b?.slug).toBe("musterversicherung");
    expect(c?.slug).toBe("musterversicherung");
  });

  it("is case- and punctuation-insensitive", () => {
    expect(resolveCorrespondent("beispielbank AG", KNOWN)?.slug).toBe("beispielbank");
    expect(resolveCorrespondent("BEISPIEL-BANK", KNOWN)?.slug).toBe("beispielbank");
  });

  it("folds umlauts when matching a fragment", () => {
    expect(resolveCorrespondent("Prüfstelle SÜD Auto Service GmbH", KNOWN)).toEqual({
      slug: "pruefstelle-sued",
      display: "Prüfstelle Süd",
    });
  });

  it("unifies several fragments of one institution", () => {
    expect(resolveCorrespondent("Musterbank Banking AG", KNOWN)?.slug).toBe("musterbank");
    expect(resolveCorrespondent("Musterbank Lebensversicherung AG", KNOWN)?.slug).toBe("musterbank");
  });

  it("knows no institution without overrides: the code ships none", () => {
    expect(resolveCorrespondent("Musterversicherung Sach AG")).toEqual({
      slug: "musterversicherung-sach-ag",
      display: "Musterversicherung Sach AG",
    });
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

  it("prefers the longest matching override regardless of database order", () => {
    const broadFirst = [
      { pattern: "post", slug: "post-allgemein", display: "Post allgemein" },
      { pattern: "deutschepost", slug: "deutsche-post", display: "Deutsche Post" },
    ];
    const specificFirst = [...broadFirst].reverse();

    expect(resolveCorrespondent("Deutsche Post AG", broadFirst)?.slug).toBe("deutsche-post");
    expect(resolveCorrespondent("Deutsche Post AG", specificFirst)?.slug).toBe("deutsche-post");
  });

  it("breaks equally specific override ties deterministically", () => {
    const overrides = [
      { pattern: "werke", slug: "werke", display: "Werke" },
      { pattern: "stadt", slug: "stadt", display: "Stadt" },
    ];

    expect(resolveCorrespondent("Stadtwerke", overrides)?.slug).toBe("stadt");
    expect(resolveCorrespondent("Stadtwerke", [...overrides].reverse())?.slug).toBe("stadt");
  });

  it("falls back to the slugified sender when no override pattern matches", () => {
    const overrides = [{ pattern: "andereversicherung", slug: "andere", display: "Andere" }];
    expect(resolveCorrespondent("Musterversicherung", overrides)?.slug).toBe("musterversicherung");
  });

  it("threads overrides through buildCorrespondentFolderSlug", () => {
    const overrides = [{ pattern: "musterversicherung", slug: "versicherung-x", display: "Versicherung X" }];
    expect(
      buildCorrespondentFolderSlug(
        { sender: "Musterversicherung", title: "Hausratversicherung", tags: [] },
        overrides,
      ),
    ).toBe("versicherung-x-hausrat");
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
        sender: "Musterversicherung AG",
        title: "Privathaftpflichtversicherung 2024",
        tags: ["versicherungsnr:4711884", "kundennr:99"],
      }),
    ).toBe("musterversicherung-ag-privathaftpflicht-4711884");
  });

  it("omits the contract anchor when no contract tag is present", () => {
    expect(
      buildCorrespondentFolderSlug({
        sender: "Musterversicherung",
        title: "Hausratversicherung",
        tags: [],
      }),
    ).toBe("musterversicherung-hausrat");
  });

  it("falls back to sender-only when neither product nor contract is known", () => {
    expect(
      buildCorrespondentFolderSlug({
        sender: "Beispielbank",
        title: "Depotauszug",
      }),
    ).toBe("beispielbank");
  });

  it("separates two same-Sparte contracts from the same provider by anchor", () => {
    const a = buildCorrespondentFolderSlug({
      sender: "Musterversicherung",
      title: "Privathaftpflichtversicherung",
      tags: ["versicherungsnr:111"],
    });
    const b = buildCorrespondentFolderSlug({
      sender: "Musterversicherung",
      title: "Privathaftpflichtversicherung",
      tags: ["versicherungsnr:222"],
    });
    expect(a).toBe("musterversicherung-privathaftpflicht-111");
    expect(b).toBe("musterversicherung-privathaftpflicht-222");
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
