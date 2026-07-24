import { describe, it, expect } from "vitest";
import {
  DOCUMENT_TYPES,
  documentTypeName,
  findDocumentType,
  isValidDocumentTypeSlug,
} from "./document-types";

describe("DOCUMENT_TYPES", () => {
  it("has unique slugs", () => {
    const slugs = DOCUMENT_TYPES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("uses lowercase ascii slugs (filesystem/URL safe, no umlauts)", () => {
    for (const t of DOCUMENT_TYPES) {
      expect(t.slug).toMatch(/^[a-z]+$/);
    }
  });

  it("gives every type a non-empty name and hint", () => {
    for (const t of DOCUMENT_TYPES) {
      expect(t.name.trim().length).toBeGreaterThan(0);
      expect(t.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it("includes the sonstiges escape hatch", () => {
    expect(isValidDocumentTypeSlug("sonstiges")).toBe(true);
  });
});

describe("isValidDocumentTypeSlug", () => {
  it("accepts every declared slug", () => {
    for (const t of DOCUMENT_TYPES) {
      expect(isValidDocumentTypeSlug(t.slug)).toBe(true);
    }
  });

  it("rejects unknown or malformed input", () => {
    expect(isValidDocumentTypeSlug("nope")).toBe(false);
    expect(isValidDocumentTypeSlug("")).toBe(false);
    expect(isValidDocumentTypeSlug(null)).toBe(false);
    expect(isValidDocumentTypeSlug(42)).toBe(false);
    expect(isValidDocumentTypeSlug("Rechnung")).toBe(false); // case-sensitive
  });
});

describe("findDocumentType / documentTypeName", () => {
  it("resolves a known slug to its metadata and name", () => {
    expect(findDocumentType("rechnung")?.name).toBe("Rechnung / Mahnung");
    expect(documentTypeName("rechnung")).toBe("Rechnung / Mahnung");
  });

  it("falls back to the raw slug for an unknown value", () => {
    expect(findDocumentType("unknown")).toBeUndefined();
    expect(documentTypeName("unknown")).toBe("unknown");
  });

  it("returns null for empty input", () => {
    expect(documentTypeName(null)).toBeNull();
    expect(documentTypeName(undefined)).toBeNull();
    expect(documentTypeName("")).toBeNull();
  });
});
