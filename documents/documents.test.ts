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
import { DuplicateDocumentError } from "./import";
import { SUPPORTED_EXTENSIONS } from "./documents.service";
import { reciprocalRankFusion, type SearchHit } from "./search";
import { hasPoorSpacing } from "./text-extract";

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

describe("documents.import", () => {
  it("DuplicateDocumentError exposes the existing document id", () => {
    const err = new DuplicateDocumentError(42);
    expect(err.existingId).toBe(42);
    expect(err.name).toBe("DuplicateDocumentError");
    expect(err.message).toBe("DOCUMENT_ALREADY_EXISTS");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("documents.inbox supported extensions", () => {
  it("only PDFs are eligible for inbox import", () => {
    expect(SUPPORTED_EXTENSIONS.has(".pdf")).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has(".jpg")).toBe(false);
    expect(SUPPORTED_EXTENSIONS.has(".docx")).toBe(false);
  });
});

describe("documents.text-extract hasPoorSpacing", () => {
  it("returns false for short text (not enough signal to judge)", () => {
    expect(hasPoorSpacing("Kurze Notiz ohne viel Inhalt.")).toBe(false);
    expect(hasPoorSpacing("")).toBe(false);
  });

  it("returns false for well-formed German prose", () => {
    // 400+ chars of realistic invoice prose.
    const text = (
      "Sehr geehrte Damen und Herren, anbei erhalten Sie unsere Rechnung " +
      "für den Monat April 2026. Der Gesamtbetrag beläuft sich auf 1.234,56 " +
      "Euro und ist innerhalb von 14 Tagen ohne Abzug zahlbar. Bitte " +
      "überweisen Sie den Betrag auf das unten angegebene Konto unter " +
      "Angabe der Rechnungsnummer. Mit freundlichen Grüßen, Ihre " +
      "Buchhaltung. Dieses Schreiben wurde maschinell erstellt."
    );
    expect(hasPoorSpacing(text)).toBe(false);
  });

  it("flags text with no spaces at all (broken text layer)", () => {
    // 400+ chars of glued text — a typical pdf-parse output when the
    // PDF stores words as positioned glyph runs without space characters.
    const glued =
      "SehrgeehrteDamenundHerrenanbeierhaltenSieunsereRechnungfürdenMonatApril" +
      "2026DerGesamtbetragbeläuftsichauf1234Euroundistinnerhalbvon14Tagenohne" +
      "AbzugzahlbarBitteüberweisenSiedenBetragaufdasuntenangegebeneKontounter" +
      "AngabederRechnungsnummerMitfreundlichenGrüßenIhreBuchhaltungDiesesSchreiben" +
      "wurdemaschinellerstelltundenthältdahetypischerweisekeinehandschriftlicheUnterschrift";
    expect(hasPoorSpacing(glued)).toBe(true);
  });

  it("flags text where most tokens exceed the glued-length threshold", () => {
    // Occasional newlines but individual tokens are still absurdly long.
    const chunks: string[] = [];
    for (let i = 0; i < 15; i++) {
      chunks.push("VieleWorteOhneLeerzeichenAberMitZeilenumbruchZwischendrin" + i);
    }
    const text = chunks.join("\n");
    expect(hasPoorSpacing(text)).toBe(true);
  });
});

describe("documents.search reciprocalRankFusion", () => {
  it("returns an empty array when both lists are empty", () => {
    expect(reciprocalRankFusion([[], []], 60)).toEqual([]);
  });

  it("documents appearing in both lists outrank singletons", () => {
    const fts: SearchHit[] = [
      { document_id: 1, score: 0.9, fts_rank: 0.9 },
      { document_id: 2, score: 0.5, fts_rank: 0.5 },
    ];
    const semantic: SearchHit[] = [
      { document_id: 2, score: 0.8, semantic_distance: 0.2 },
      { document_id: 3, score: 0.7, semantic_distance: 0.3 },
    ];
    const fused = reciprocalRankFusion([fts, semantic], 60);
    expect(fused[0].document_id).toBe(2);
    const ids = fused.map((h) => h.document_id);
    expect(ids.sort()).toEqual([1, 2, 3]);
  });

  it("respects rank position: rank-1 contributes more than rank-2", () => {
    const listA: SearchHit[] = [{ document_id: 1, score: 1 }];
    const listB: SearchHit[] = [{ document_id: 2, score: 1 }, { document_id: 1, score: 0.5 }];
    const fused = reciprocalRankFusion([listA, listB], 60);
    const a = fused.find((h) => h.document_id === 1)!;
    const b = fused.find((h) => h.document_id === 2)!;
    // doc 1 = 1/61 + 1/62, doc 2 = 1/61 → doc 1 wins
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("preserves per-branch metadata (fts_rank, semantic_distance)", () => {
    const fts: SearchHit[] = [{ document_id: 7, score: 0.4, fts_rank: 0.4 }];
    const semantic: SearchHit[] = [{ document_id: 7, score: 0.9, semantic_distance: 0.1 }];
    const [hit] = reciprocalRankFusion([fts, semantic], 60);
    expect(hit.document_id).toBe(7);
    expect(hit.fts_rank).toBe(0.4);
    expect(hit.semantic_distance).toBe(0.1);
  });

  it("K dampens the advantage of top ranks as it grows", () => {
    const fts: SearchHit[] = [{ document_id: 1, score: 1 }];
    const semantic: SearchHit[] = [{ document_id: 2, score: 1 }, { document_id: 1, score: 0.5 }];
    const smallK = reciprocalRankFusion([fts, semantic], 1);
    const largeK = reciprocalRankFusion([fts, semantic], 1000);
    const gap = (f: SearchHit[]) =>
      f.find((h) => h.document_id === 1)!.score - f.find((h) => h.document_id === 2)!.score;
    expect(gap(smallK)).toBeGreaterThan(gap(largeK));
  });
});
