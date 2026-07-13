import { describe, expect, it } from "vitest";

import {
  buildSpeakingFileName,
  type DocumentLocationContext,
} from "./documents.service";

describe("documents.service document filename prefix", () => {
  const base: DocumentLocationContext = {
    ownerLogin: "max@example.test",
    visibility: "private",
    groupName: null,
    groupSlug: null,
    categorySlugs: ["finanzen"],
    status: "ready",
    docDate: "2026-04-15",
    documentNumber: null,
    uploadedAt: new Date("2026-04-17T12:00:00Z"),
    sender: "Finanzamt München",
    title: "Einkommensteuerbescheid 2025",
    originalFilename: "scan.pdf",
    sha256: "a1b2c3d4e5f6",
    ext: ".pdf",
  };

  it("uses the document year instead of repeating the full document date", () => {
    expect(buildSpeakingFileName(base)).toBe(
      "2026_finanzamt-muenchen_einkommensteuerbescheid-2025__a1b2c3d4.pdf",
    );
  });

  it("omits the year prefix when no document date exists", () => {
    expect(buildSpeakingFileName({ ...base, docDate: null })).toBe(
      "2026-04-17_finanzamt-muenchen_einkommensteuerbescheid-2025__a1b2c3d4.pdf",
    );
  });

  it("adds a #documentNumber prefix when a document number exists", () => {
    expect(buildSpeakingFileName({ ...base, documentNumber: "2661160" })).toBe(
      "2026_#2661160_finanzamt-muenchen_einkommensteuerbescheid-2025__a1b2c3d4.pdf",
    );
  });

  it("keeps #documentNumber even when the document year is unavailable", () => {
    expect(buildSpeakingFileName({
      ...base,
      docDate: null,
      documentNumber: "2661160",
    })).toBe(
      "#2661160_2026-04-17_finanzamt-muenchen_einkommensteuerbescheid-2025__a1b2c3d4.pdf",
    );
  });
});
