import { describe, it, expect } from "vitest";
import {
  applySubjectPersonDeductionReviewConfidence,
  detectSubjectPersonIds,
  detectSubjectPersonPersonalDeductionReview,
  extractDocumentNumber,
  extractReferenceNumberTags,
  isSubjectPersonSender,
  reconcileSubjectPersonTags,
} from "./metadata-extract";

describe("extractDocumentNumber", () => {
  it("returns the digits of a #1234 marker without the hash", () => {
    expect(extractDocumentNumber("… Beleg #2661160 vom 1.1.")).toBe("2661160");
    expect(extractDocumentNumber("Auftrag #4711 erteilt")).toBe("4711");
  });

  it("allows a single separator between the # and the digits", () => {
    expect(extractDocumentNumber("Beleg #.2661160")).toBe("2661160");
    expect(extractDocumentNumber("Beleg # 4711")).toBe("4711");
    expect(extractDocumentNumber("Beleg #-4711")).toBe("4711");
    expect(extractDocumentNumber("Beleg #/4711")).toBe("4711");
  });

  it("ignores numbers that are not marked with #", () => {
    expect(extractDocumentNumber("Rechnungsnummer 2661160")).toBeNull();
    expect(extractDocumentNumber("Vertragskonto 123456")).toBeNull();
  });

  it("requires at least four digits and returns null otherwise", () => {
    expect(extractDocumentNumber("Zimmer #12")).toBeNull();
    expect(extractDocumentNumber("kein Marker hier")).toBeNull();
  });
});

describe("isSubjectPersonSender", () => {
  const persons = [{ full_name: "Erika Mustermann" }, { full_name: "Anton Beispiel" }];

  it("matches the person's name in any order, with or without salutation", () => {
    expect(isSubjectPersonSender("Erika Mustermann", persons)).toBe(true);
    expect(isSubjectPersonSender("Mustermann, Erika", persons)).toBe(true);
    expect(isSubjectPersonSender("Frau Erika Mustermann", persons)).toBe(true);
    expect(isSubjectPersonSender("Anton Beispiel", persons)).toBe(true);
  });

  it("does not match a company that merely contains the surname", () => {
    expect(isSubjectPersonSender("Mustermann GmbH", persons)).toBe(false);
    expect(isSubjectPersonSender("HALLESCHE Krankenversicherung", persons)).toBe(false);
  });

  it("does not match on a lone first name or empty sender", () => {
    expect(isSubjectPersonSender("Erika", persons)).toBe(false);
    expect(isSubjectPersonSender(null, persons)).toBe(false);
    expect(isSubjectPersonSender("", persons)).toBe(false);
  });
});

describe("detectSubjectPersonIds", () => {
  const persons = [
    { id: 1, full_name: "Erika Mustermann" },
    { id: 2, full_name: "Anton Beispiel" },
  ];

  it("matches a person whose full name appears in any order", () => {
    expect(detectSubjectPersonIds("Patientin: Erika Mustermann, geb. 1950", persons)).toEqual([1]);
    expect(detectSubjectPersonIds("Rechnung an Mustermann, Erika", persons)).toEqual([1]);
    expect(detectSubjectPersonIds("Betreff Anton Beispiel und Erika Mustermann", persons)).toEqual([
      1, 2,
    ]);
  });

  it("requires every name token and ignores partial mentions", () => {
    expect(detectSubjectPersonIds("nur Erika wird erwähnt", persons)).toEqual([]);
    expect(detectSubjectPersonIds("kein Name hier", persons)).toEqual([]);
  });
});

describe("extractReferenceNumberTags", () => {
  it("captures labelled contract/insurance/order numbers as tags", () => {
    expect(extractReferenceNumberTags("Versicherungsnummer: ABC-12345")).toEqual([
      "versicherungsnr:abc-12345",
    ]);
    expect(extractReferenceNumberTags("Vertragskonto 123456")).toEqual(["vertragsnr:123456"]);
    expect(extractReferenceNumberTags("Ihre Auftragsnummer 778899 wurde erfasst")).toEqual([
      "auftragsnr:778899",
    ]);
    expect(extractReferenceNumberTags("Kunden-Nr. 4567890")).toEqual(["kundennr:4567890"]);
    expect(extractReferenceNumberTags("Policennummer 99001122")).toEqual([
      "versicherungsnr:99001122",
    ]);
  });

  it("requires a digit-bearing value and deduplicates", () => {
    expect(extractReferenceNumberTags("Vertragsnummer: ohne")).toEqual([]);
    expect(extractReferenceNumberTags("kein label hier 123456")).toEqual([]);
    expect(
      extractReferenceNumberTags("Vertragskonto 123456 … Vertragsnummer 123456"),
    ).toEqual(["vertragsnr:123456"]);
  });
});

describe("reconcileSubjectPersonTags", () => {
  const persons = [
    { id: 1, relation_tag: "Manuel" },
    { id: 2, relation_tag: "Isabella" },
    { id: 3, relation_tag: "Vater" },
    { id: 4, relation_tag: "Mutter" },
  ];

  it("drops relation tags the detector did not confirm (the reported bug)", () => {
    // LLM hallucinated Isabella + Vater; only Manuel was actually detected.
    const out = reconcileSubjectPersonTags(
      ["Manuel", "Isabella", "Vater", "sprachreise"],
      persons,
      [1],
    );
    expect(out).toContain("Manuel");
    expect(out).toContain("sprachreise"); // content tag untouched
    expect(out).not.toContain("Isabella");
    expect(out).not.toContain("Vater");
  });

  it("drops all person tags when the detector confirms none (OCR-garbled names)", () => {
    const out = reconcileSubjectPersonTags(["Manuel", "Isabella", "Vater"], persons, []);
    expect(out).toEqual([]);
  });

  it("does not auto-add detected persons the LLM intentionally omitted", () => {
    // The LLM decides who is relevant; the detector only removes hallucinations.
    // A detected name (e.g. child on a payslip) that the LLM did not tag stays out.
    const out = reconcileSubjectPersonTags(["plymouth"], persons, [4]);
    expect(out).toEqual(["plymouth"]);
  });

  it("leaves documents without Bezugspersonen untouched", () => {
    const out = reconcileSubjectPersonTags(["rechnung", "o2"], [], []);
    expect(out).toEqual(["rechnung", "o2"]);
  });

  it("matches relation tags case-insensitively and de-duplicates", () => {
    const out = reconcileSubjectPersonTags(["manuel", "Manuel", "MANUEL"], persons, [1]);
    expect(out).toEqual(["manuel"]);
  });
});

describe("detectSubjectPersonPersonalDeductionReview", () => {
  it("flags personal deduction sections for review when the document concerns a Bezugsperson", () => {
    expect(
      detectSubjectPersonPersonalDeductionReview({
        detectedSubjectPersonIds: [4],
        taxSections: [
          { slug: "sonderausgaben" },
          { slug: "haushaltsnahe" },
        ],
      }),
    ).toEqual({
      shouldReview: true,
      reviewSlugs: ["sonderausgaben", "haushaltsnahe"],
    });
  });

  it("does not flag when no Bezugsperson was detected", () => {
    expect(
      detectSubjectPersonPersonalDeductionReview({
        detectedSubjectPersonIds: [],
        taxSections: [{ slug: "haushaltsnahe" }],
      }),
    ).toEqual({ shouldReview: false, reviewSlugs: [] });
  });

  it("does not flag non-personal tax sections such as Anlage Unterhalt or income sections", () => {
    expect(
      detectSubjectPersonPersonalDeductionReview({
        detectedSubjectPersonIds: [4],
        taxSections: [
          { slug: "anlage-unterhalt" },
          { slug: "anlage-r" },
          { slug: "steuerbescheid" },
        ],
      }),
    ).toEqual({ shouldReview: false, reviewSlugs: [] });
  });

  it("deduplicates and normalises review slugs", () => {
    expect(
      detectSubjectPersonPersonalDeductionReview({
        detectedSubjectPersonIds: [4],
        taxSections: [
          { slug: " Haushaltsnahe " },
          { slug: "haushaltsnahe" },
        ],
      }),
    ).toEqual({ shouldReview: true, reviewSlugs: ["haushaltsnahe"] });
  });
});

describe("applySubjectPersonDeductionReviewConfidence", () => {
  it("lowers even a learned-category confidence bump to review level", () => {
    expect(applySubjectPersonDeductionReviewConfidence(0.9, true)).toBe(0.55);
  });

  it("keeps already-lower confidence unchanged", () => {
    expect(applySubjectPersonDeductionReviewConfidence(0.4, true)).toBe(0.4);
  });

  it("does nothing when the review signal is absent", () => {
    expect(applySubjectPersonDeductionReviewConfidence(0.9, false)).toBe(0.9);
  });
});
