import { describe, it, expect } from "vitest";
import path from "path";

import {
  DOCUMENTS_DIR,
  GROUP_SEGMENT,
  INBOX_SEGMENT,
  STEUER_SEGMENT,
  assertPathUnderDocumentsRoot,
  buildSpeakingFileName,
  composeOwnerRootSegment,
  getDocumentDiskPath,
  getInitialUploadDiskPath,
  guessExtension,
  resolveDocumentDiskPath,
  resolveTaxLinkPath,
  slugifyName,
  slugifyUserLogin,
  type DocumentLocationContext,
} from "./documents.service";
import { flattenTaxonomy, taxonomyHints, categoryTaxonomy, type CategorySeed } from "./taxonomy";
import { DOCUMENT_SERVICES } from "./scan-queue";
import { DuplicateDocumentError } from "./import";
import { SUPPORTED_EXTENSIONS } from "./documents.service";
import { reciprocalRankFusion, visibilityClause, type SearchHit } from "./search";
import { PgDialect } from "drizzle-orm/pg-core";
import { chunkText } from "./document-ops";
import { hasPoorSpacing, looksLikeBrokenXref } from "./text-extract";

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

describe("documents.service slugifyName", () => {
  it("folds German umlauts to two-letter forms", () => {
    expect(slugifyName("Öl-Rückstellung für Jäger")).toBe("oel-rueckstellung-fuer-jaeger");
    expect(slugifyName("Straße")).toBe("strasse");
  });

  it("strips diacritics and collapses non-alphanumerics", () => {
    expect(slugifyName("naïve résumé")).toBe("naive-resume");
    expect(slugifyName("  Hello---World!! ")).toBe("hello-world");
  });

  it("caps length and trims trailing hyphens", () => {
    const long = "a".repeat(80) + "-tail";
    expect(slugifyName(long, 60).length).toBeLessThanOrEqual(60);
    expect(slugifyName("foobar---", 60)).toBe("foobar");
  });

  it("returns empty string for inputs that reduce to nothing", () => {
    expect(slugifyName("")).toBe("");
    expect(slugifyName("!!!")).toBe("");
  });
});

describe("documents.service slugifyUserLogin", () => {
  it("uses the local part of the email address", () => {
    expect(slugifyUserLogin("max.mueller@example.com", 1)).toBe("max-mueller");
  });

  it("falls back to user-<id> for purely unsluggable local parts", () => {
    expect(slugifyUserLogin("!!!@example.com", 42)).toBe("user-42");
    expect(slugifyUserLogin("", 9)).toBe("user-9");
  });
});

describe("documents.service buildSpeakingFileName", () => {
  const base: DocumentLocationContext = {
    visibility: "private",
    userLoginSlug: "max",
    groupSlug: null,
    categorySlugs: null,
    status: "ready",
    docDate: "2026-04-15",
    uploadedAt: new Date("2026-04-17T12:00:00Z"),
    sender: "Finanzamt München",
    title: "Einkommensteuerbescheid 2025",
    originalFilename: "bescheid.pdf",
    sha256: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7081920a1b2c3d",
    ext: ".pdf",
  };

  it("joins date, sender, title and hash8 suffix", () => {
    expect(buildSpeakingFileName(base)).toBe(
      "2026-04-15_finanzamt-muenchen_einkommensteuerbescheid-2025__a1b2c3d4.pdf",
    );
  });

  it("falls back to uploaded date when docDate is null", () => {
    const out = buildSpeakingFileName({ ...base, docDate: null });
    expect(out.startsWith("2026-04-17_")).toBe(true);
  });

  it("drops missing sender/title parts but keeps the date + hash", () => {
    // Sender and title reduce to empty slugs; the date remains the sole
    // human-readable part. `dokument` is the final fallback reserved for
    // the pathological case where *nothing* (not even the date) would
    // remain.
    const out = buildSpeakingFileName({
      ...base,
      sender: null,
      title: null,
      originalFilename: "!!!.pdf",
    });
    expect(out).toBe("2026-04-15__a1b2c3d4.pdf");
  });
});

describe("documents.service resolveDocumentDiskPath", () => {
  const readyCtx: DocumentLocationContext = {
    visibility: "private",
    userLoginSlug: "max",
    groupSlug: null,
    categorySlugs: ["finanzen", "steuern"],
    status: "ready",
    docDate: "2026-04-15",
    uploadedAt: new Date("2026-04-17T00:00:00Z"),
    sender: "Finanzamt",
    title: "Bescheid",
    originalFilename: "bescheid.pdf",
    sha256: "a".repeat(64),
    ext: ".pdf",
  };

  it("places classified documents under <owner>/<category>/<year>/", () => {
    const { relPath, inbox } = resolveDocumentDiskPath(readyCtx);
    expect(inbox).toBe(false);
    expect(relPath).toBe(
      path.join("max", "finanzen", "steuern", "2026", "2026-04-15_finanzamt_bescheid__aaaaaaaa.pdf"),
    );
  });

  it("places unclassified documents under <owner>/_inbox/YYYY-MM/", () => {
    const { relPath, inbox } = resolveDocumentDiskPath({
      ...readyCtx,
      status: "pending",
      categorySlugs: null,
    });
    expect(inbox).toBe(true);
    expect(relPath.startsWith(path.join("max", INBOX_SEGMENT, "2026-04"))).toBe(true);
  });

  it("uses _gruppe/<slug> for group-visible documents", () => {
    const { relPath } = resolveDocumentDiskPath({
      ...readyCtx,
      visibility: "group",
      userLoginSlug: null,
      groupSlug: "familie-mueller",
    });
    expect(relPath.startsWith(path.join(GROUP_SEGMENT, "familie-mueller"))).toBe(true);
  });

  it("refuses group documents without a groupSlug", () => {
    expect(() =>
      resolveDocumentDiskPath({
        ...readyCtx,
        visibility: "group",
        userLoginSlug: null,
        groupSlug: null,
      }),
    ).toThrow(/groupSlug/);
  });

  it("resolveTaxLinkPath lands under <owner>/_steuer/<year>/<section>", () => {
    const { relPath } = resolveTaxLinkPath(readyCtx, 2025, "anlage-n");
    expect(relPath).toBe(
      path.join("max", STEUER_SEGMENT, "2025", "anlage-n", "2026-04-15_finanzamt_bescheid__aaaaaaaa.pdf"),
    );
  });
});

describe("documents.service composeOwnerRootSegment / getInitialUploadDiskPath", () => {
  it("produces the uploader root for private visibility", () => {
    expect(
      composeOwnerRootSegment({
        visibility: "private",
        userLoginSlug: "max",
        groupSlug: null,
      }),
    ).toBe("max");
  });

  it("produces the _gruppe/<slug> root for group visibility", () => {
    expect(
      composeOwnerRootSegment({
        visibility: "group",
        userLoginSlug: null,
        groupSlug: "familie-mueller",
      }),
    ).toBe(path.join(GROUP_SEGMENT, "familie-mueller"));
  });

  it("initial upload path places the sha256 under owner/_inbox/YYYY-MM/", () => {
    const { relPath } = getInitialUploadDiskPath(
      "max",
      "0".repeat(64),
      ".pdf",
      new Date("2026-04-17T00:00:00Z"),
    );
    expect(relPath).toBe(
      path.join("max", INBOX_SEGMENT, "2026-04", "0".repeat(64) + ".pdf"),
    );
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

describe("documents.text-extract looksLikeBrokenXref", () => {
  it("matches the poppler signature seen in production", () => {
    // Verbatim from the user-reported failure.
    const stderr =
      "pdftoppm exited 1: Syntax Error: Couldn't find trailer dictionary " +
      "Syntax Error: Couldn't find trailer dictionary " +
      "Syntax Error: Couldn't read xref table";
    expect(looksLikeBrokenXref(stderr)).toBe(true);
  });

  it("matches pdf.js' broken-xref signatures from pdf-parse", () => {
    expect(looksLikeBrokenXref("FormatError: Bad (uncompressed) XRef entry")).toBe(true);
    expect(looksLikeBrokenXref("Invalid XRef stream header")).toBe(true);
  });

  it("matches the 'May not be a PDF file' signature", () => {
    expect(
      looksLikeBrokenXref("May not be a PDF file (continuing anyway)"),
    ).toBe(true);
  });

  it("does not match unrelated failures (encrypted, missing binary, OOM)", () => {
    expect(looksLikeBrokenXref("")).toBe(false);
    expect(
      looksLikeBrokenXref("pdftoppm exited 1: Document is encrypted"),
    ).toBe(false);
    expect(
      looksLikeBrokenXref("spawn pdftoppm ENOENT"),
    ).toBe(false);
    expect(
      looksLikeBrokenXref("pdftoppm exited 137: out of memory"),
    ).toBe(false);
  });
});

describe("documents.taxonomy seed shape", () => {
  function findBySlug(nodes: CategorySeed[], slug: string): CategorySeed | undefined {
    for (const n of nodes) {
      if (n.slug === slug) return n;
      const child = n.children && findBySlug(n.children, slug);
      if (child) return child;
    }
    return undefined;
  }

  it("includes the new Gesundheit subcategories for Pflege", () => {
    const gesundheit = findBySlug(categoryTaxonomy, "gesundheit");
    expect(gesundheit?.children?.map((c) => c.slug)).toEqual(
      expect.arrayContaining(["gesundheit-pflege", "gesundheit-pflegekasse"]),
    );
  });

  it("includes a dedicated Finanzen subcategory for securities & dividends", () => {
    const finanzen = findBySlug(categoryTaxonomy, "finanzen");
    expect(finanzen?.children?.map((c) => c.slug)).toEqual(
      expect.arrayContaining(["finanzen-wertpapiere"]),
    );
    const wertpapiere = findBySlug(categoryTaxonomy, "finanzen-wertpapiere");
    expect(wertpapiere?.name).toBe("Wertpapiere & Dividenden");
    // Hint steers dividend tax statements here rather than into finanzen-steuern.
    expect(wertpapiere?.hint).toMatch(/Steuermitteilungen/);
  });

  it("exposes category hints via flattenTaxonomy and taxonomyHints", () => {
    const flat = flattenTaxonomy();
    const wertpapiere = flat.find((r) => r.slug === "finanzen-wertpapiere");
    expect(wertpapiere?.hint).toMatch(/Dividendengutschriften/);
    // Un-hinted leaves carry null, not undefined.
    expect(flat.find((r) => r.slug === "wohnen-miete")?.hint).toBeNull();

    const hints = taxonomyHints();
    expect(hints.get("finanzen-wertpapiere")).toMatch(/Dividendengutschriften/);
    expect(hints.has("wohnen-miete")).toBe(false);
  });

  it("includes the new top-level Betreuung branch with its sections", () => {
    const betreuung = findBySlug(categoryTaxonomy, "betreuung");
    expect(betreuung?.icon).toBe("pi-id-card");
    expect(betreuung?.children?.map((c) => c.slug)).toEqual([
      "betreuung-bestellung",
      "betreuung-rechenschaftsbericht",
      "betreuung-vermoegensverzeichnis",
      "betreuung-genehmigung",
      "betreuung-korrespondenz",
    ]);
  });

  it("flattens every new node with the right parent_slug", () => {
    const rows = flattenTaxonomy();
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    expect(bySlug.get("gesundheit-pflege")?.parent_slug).toBe("gesundheit");
    expect(bySlug.get("betreuung-rechenschaftsbericht")?.parent_slug).toBe("betreuung");
    expect(bySlug.get("betreuung")?.parent_slug).toBeNull();
  });
});

describe("documents.search visibilityClause", () => {
  const dialect = new PgDialect();

  it("renders the group branch as a proper int[] array (not a row tuple)", () => {
    // Regression: drizzle's sql template spreads a JS array into
    // comma-separated parameters surrounded by parens, which Postgres
    // parses as a record. `group_id = ANY((1, 2))` then fails with
    // `op ANY/ALL (array) requires array on right side`. The fix wraps
    // the elements in an explicit ARRAY[...]::int[] literal.
    const { sql: rendered, params } = dialect.sqlToQuery(
      visibilityClause(1, [10, 20]),
    );
    expect(rendered).toContain("ARRAY[");
    expect(rendered).toContain("]::int[]");
    expect(rendered).toMatch(/ANY\(ARRAY\[/);
    expect(rendered).not.toMatch(/ANY\(\(\$\d+,\s*\$\d+\)\)/);
    // Each group id is its own bind parameter alongside the userId.
    expect(params).toEqual([1, 10, 20]);
  });

  it("omits the group branch entirely when the caller has no groups", () => {
    const { sql: rendered, params } = dialect.sqlToQuery(visibilityClause(7, []));
    expect(rendered).not.toContain("group_id");
    expect(rendered).not.toContain("ARRAY[");
    expect(params).toEqual([7]);
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

describe("documents.document-ops chunkText", () => {
  it("returns the input as a single chunk when it fits in maxChars", () => {
    expect(chunkText("hello world", 100)).toEqual(["hello world"]);
  });

  it("splits on paragraph boundaries when paragraphs do not all fit", () => {
    const text = "para one is here.\n\npara two is also here.\n\npara three is too.";
    const chunks = chunkText(text, 30);
    // Each chunk holds roughly one paragraph, never more than maxChars.
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
  });

  it("disjoint chunks (overlap=0) preserve the historical behaviour", () => {
    const text = "AAAA AAAA\n\nBBBB BBBB\n\nCCCC CCCC";
    const chunks = chunkText(text, 12, 0);
    // No chunk shares its prefix with the previous chunk's suffix.
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const cur = chunks[i];
      const prevTail = prev.slice(-4);
      expect(cur.startsWith(prevTail)).toBe(false);
    }
  });

  it("non-zero overlap copies a word-aligned tail of the previous chunk", () => {
    const text = "alpha beta gamma\n\ndelta epsilon zeta\n\neta theta iota";
    const chunks = chunkText(text, 20, 8);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Each chunk after the first must start with text that appeared
    // somewhere near the end of the previous chunk — that's the
    // overlap window. We validate this by asserting that the first
    // word of chunk[i] also appears in chunk[i-1].
    for (let i = 1; i < chunks.length; i++) {
      const firstWord = chunks[i].split(/\s/)[0];
      expect(chunks[i - 1]).toContain(firstWord);
    }
  });

  it("overlap is suppressed when the previous chunk is shorter than the overlap window", () => {
    // Each paragraph (`AAAA`) is 4 chars, overlap window 8 chars — the
    // chunker must NOT carry the entire short chunk as overlap because
    // that would just duplicate it wholesale.
    const text = "AAAA\n\nBBBB\n\nCCCC";
    const chunks = chunkText(text, 4, 8);
    expect(chunks).toEqual(["AAAA", "BBBB", "CCCC"]);
  });

  it("hard-splits an over-long single paragraph and overlaps each cut", () => {
    const long = "abcdefghij".repeat(10); // 100 chars, no whitespace
    const chunks = chunkText(long, 30, 10);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    // Each subsequent chunk starts with the last 10 chars of its
    // predecessor (no whitespace to snap to, so the raw window is used).
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startsWith(chunks[i - 1].slice(-10))).toBe(true);
    }
  });
});
