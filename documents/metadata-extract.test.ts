import { describe, it, expect } from "vitest";
import {
  extractDocumentNumber,
  extractReferenceNumberTags,
  isSubjectPersonSender,
} from "./metadata-extract";

describe("extractDocumentNumber", () => {
  it("returns the digits of a #1234 marker without the hash", () => {
    expect(extractDocumentNumber("… Beleg #2661160 vom 1.1.")).toBe("2661160");
    expect(extractDocumentNumber("Auftrag #4711 erteilt")).toBe("4711");
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
  const persons = [{ full_name: "Erika Mustermann" }, { full_name: "Anton Schegg" }];

  it("matches the person's name in any order, with or without salutation", () => {
    expect(isSubjectPersonSender("Erika Mustermann", persons)).toBe(true);
    expect(isSubjectPersonSender("Mustermann, Erika", persons)).toBe(true);
    expect(isSubjectPersonSender("Frau Erika Mustermann", persons)).toBe(true);
    expect(isSubjectPersonSender("Anton Schegg", persons)).toBe(true);
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
