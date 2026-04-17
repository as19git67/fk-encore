import { describe, it, expect } from "vitest";
import path from "path";

import {
  DOCUMENTS_DIR,
  assertPathUnderDocumentsRoot,
  getDocumentDiskPath,
  guessExtension,
} from "./documents.service";
import { flattenTaxonomy, categoryTaxonomy } from "./taxonomy";
import { DOCUMENT_SERVICES } from "./scan-queue";

describe("documents.service", () => {
  it("guessExtension prefers the filename extension for supported types", () => {
    expect(guessExtension("invoice.pdf", "application/pdf")).toBe(".pdf");
    expect(guessExtension("document.PDF", "application/pdf")).toBe(".pdf");
  });

  it("guessExtension falls back to mime type when the extension is unknown", () => {
    expect(guessExtension("bare-filename-no-extension", "application/pdf")).toBe(".pdf");
  });

  it("getDocumentDiskPath shards by YYYY/YYYY-MM and stores under DOCUMENTS_DIR", () => {
    const digest = "a".repeat(64);
    const fixedDate = new Date("2026-04-17T12:00:00Z");
    const { absPath, relPath, dirAbs } = getDocumentDiskPath(digest, ".pdf", fixedDate);

    expect(relPath).toBe(path.join("2026", "2026-04", `${digest}.pdf`));
    expect(dirAbs).toBe(path.join(DOCUMENTS_DIR, "2026", "2026-04"));
    expect(absPath.startsWith(DOCUMENTS_DIR)).toBe(true);
  });

  it("assertPathUnderDocumentsRoot accepts paths inside the root", () => {
    const digest = "b".repeat(64);
    const { absPath } = getDocumentDiskPath(digest, ".pdf");
    expect(() => assertPathUnderDocumentsRoot(absPath)).not.toThrow();
  });

  it("assertPathUnderDocumentsRoot rejects paths outside the root", () => {
    expect(() => assertPathUnderDocumentsRoot("/etc/passwd")).toThrow(/outside DOCUMENTS_DIR/);
    expect(() => assertPathUnderDocumentsRoot(path.join(DOCUMENTS_DIR, "..", "escape"))).toThrow(/outside DOCUMENTS_DIR/);
  });
});

describe("documents.taxonomy", () => {
  it("flattenTaxonomy lists every leaf and exposes parent_slug correctly", () => {
    const flat = flattenTaxonomy();
    expect(flat.length).toBeGreaterThan(categoryTaxonomy.length);
    for (const entry of flat) {
      expect(entry.slug).toMatch(/^[a-z0-9-]+$/);
      expect(entry.name.length).toBeGreaterThan(0);
      if (entry.parent_slug != null) {
        expect(flat.some((o) => o.slug === entry.parent_slug)).toBe(true);
      }
    }
  });

  it("taxonomy slugs are unique", () => {
    const flat = flattenTaxonomy();
    const slugs = new Set<string>();
    for (const entry of flat) {
      expect(slugs.has(entry.slug)).toBe(false);
      slugs.add(entry.slug);
    }
  });
});

describe("documents.scan-queue constants", () => {
  it("pipeline stages are declared in dependency order", () => {
    expect(DOCUMENT_SERVICES).toEqual(["text_extract", "classify", "embed"]);
  });
});
