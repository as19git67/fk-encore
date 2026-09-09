import { describe, it, expect } from "vitest";
import {
  assignStartPages,
  buildFrontMatter,
  contentsSubline,
  describePageSpec,
  formatGermanDate,
  formatPageSpec,
  frontMatterWanted,
  normalizeExcludedPages,
  qpdfMergeArgs,
  renderFrontMatter,
  selectPages,
  type CollectionPdfEntry,
  type CollectionPdfOptions,
} from "./collection-pdf";

const OPTIONS: CollectionPdfOptions = {
  title: "Unterlagen Steuererklärung 2024",
  notes: "Für den Steuerberater.",
  summary: "Enthält Lohnsteuerbescheinigung, zwei Spendenquittungen und eine Handwerkerrechnung.",
  include_cover: true,
  include_toc: true,
  include_summary: true,
  today: "2026-03-14",
};

function member(
  overrides: Partial<Omit<CollectionPdfEntry, "start_page">> = {},
): Omit<CollectionPdfEntry, "start_page"> {
  return {
    document_id: 1,
    title: "Ein Dokument",
    sender: "Beispiel GmbH",
    doc_date: "2024-05-06",
    page_count: 3,
    selected_pages: [1, 2, 3],
    ...overrides,
  };
}

describe("selectPages", () => {
  it("keeps every page when nothing is excluded", () => {
    expect(selectPages(4, [])).toEqual([1, 2, 3, 4]);
  });

  it("drops the excluded pages", () => {
    expect(selectPages(5, [2, 4])).toEqual([1, 3, 5]);
  });

  it("ignores exclusions past the end", () => {
    // A document re-uploaded with fewer pages must not make the folder
    // unexportable — the stale page number simply has nothing to drop.
    expect(selectPages(2, [3, 9])).toEqual([1, 2]);
  });

  it("can leave nothing selected", () => {
    expect(selectPages(2, [1, 2])).toEqual([]);
  });
});

describe("normalizeExcludedPages", () => {
  it("sorts, deduplicates and drops what cannot be a page", () => {
    expect(normalizeExcludedPages([3, 1, 3, 0, -2, 2.7, "4", null, "x"])).toEqual([1, 2, 3, 4]);
  });

  it("treats a non-array as no exclusion", () => {
    expect(normalizeExcludedPages(null)).toEqual([]);
    expect(normalizeExcludedPages({ 1: true })).toEqual([]);
  });
});

describe("formatPageSpec", () => {
  it("collapses consecutive runs", () => {
    expect(formatPageSpec([1, 3, 4, 5])).toBe("1,3-5");
  });

  it("keeps isolated pages separate", () => {
    expect(formatPageSpec([2, 4, 6])).toBe("2,4,6");
  });

  it("writes a single page as itself", () => {
    expect(formatPageSpec([7])).toBe("7");
  });

  it("writes one long run as a range", () => {
    expect(formatPageSpec([1, 2, 3, 4, 5])).toBe("1-5");
  });

  it("refuses an empty selection — qpdf has no spelling for it", () => {
    expect(() => formatPageSpec([])).toThrow(/empty selection/);
  });
});

describe("describePageSpec", () => {
  it("reads as German prose, with en dashes", () => {
    expect(describePageSpec([1, 3, 4, 5])).toBe("1, 3–5");
  });

  it("has a spelling for nothing selected", () => {
    expect(describePageSpec([])).toBe("–");
  });
});

describe("qpdfMergeArgs", () => {
  it("names every part with its own page range", () => {
    expect(
      qpdfMergeArgs(
        [
          { path: "/tmp/front.pdf", pages: [1] },
          { path: "/tmp/a.pdf", pages: [1, 2, 3] },
          { path: "/tmp/b.pdf", pages: [2, 5, 6] },
        ],
        "/tmp/out.pdf",
      ),
    ).toEqual([
      "--warning-exit-0",
      "--empty",
      "--pages",
      "/tmp/front.pdf",
      "1",
      "/tmp/a.pdf",
      "1-3",
      "/tmp/b.pdf",
      "2,5-6",
      "--",
      "/tmp/out.pdf",
    ]);
  });

  it("refuses to assemble nothing", () => {
    expect(() => qpdfMergeArgs([], "/tmp/out.pdf")).toThrow(/nothing to merge/);
  });
});

describe("assignStartPages", () => {
  it("starts after the front matter and advances by selected pages only", () => {
    const entries = assignStartPages(
      [
        member({ document_id: 1, selected_pages: [1, 2] }),
        // Only two of five pages are taken: the next member must start two
        // pages later, not five.
        member({ document_id: 2, page_count: 5, selected_pages: [2, 4] }),
        member({ document_id: 3, page_count: 1, selected_pages: [1] }),
      ],
      2,
    );
    expect(entries.map((e) => e.start_page)).toEqual([3, 5, 7]);
  });

  it("starts on page 1 when there is no front matter", () => {
    expect(assignStartPages([member()], 0)[0].start_page).toBe(1);
  });
});

describe("formatGermanDate", () => {
  it("turns an ISO date into a German one", () => {
    expect(formatGermanDate("2024-05-06")).toBe("06.05.2024");
  });

  it("tolerates a full timestamp", () => {
    expect(formatGermanDate("2024-05-06T10:00:00Z")).toBe("06.05.2024");
  });

  it("has nothing to say about null or nonsense", () => {
    expect(formatGermanDate(null)).toBeNull();
    expect(formatGermanDate("irgendwann")).toBeNull();
  });
});

describe("contentsSubline", () => {
  it("names sender, date and the page count when nothing was dropped", () => {
    const entry = { ...member(), start_page: 3 };
    expect(contentsSubline(entry)).toBe("Beispiel GmbH · 06.05.2024 · 3 Seiten");
  });

  it("says which pages were taken when some were dropped", () => {
    const entry = { ...member({ page_count: 7, selected_pages: [1, 3, 4, 5] }), start_page: 3 };
    expect(contentsSubline(entry)).toBe("Beispiel GmbH · 06.05.2024 · Seiten 1, 3–5 von 7");
  });

  it("leaves out what the document does not have", () => {
    const entry = {
      ...member({ sender: null, doc_date: null, page_count: 1, selected_pages: [1] }),
      start_page: 1,
    };
    expect(contentsSubline(entry)).toBe("1 Seite");
  });
});

describe("frontMatterWanted", () => {
  it("is wanted whenever the cover is on", () => {
    expect(frontMatterWanted({ ...OPTIONS, include_toc: false, include_summary: false }, 0)).toBe(
      true,
    );
  });

  it("is not wanted for a contents page with no entries", () => {
    expect(
      frontMatterWanted(
        { ...OPTIONS, include_cover: false, include_summary: false },
        0,
      ),
    ).toBe(false);
  });

  it("is wanted for a contents page that has entries", () => {
    expect(
      frontMatterWanted({ ...OPTIONS, include_cover: false, include_summary: false }, 3),
    ).toBe(true);
  });

  it("is not wanted for a summary section with no summary", () => {
    expect(
      frontMatterWanted(
        { ...OPTIONS, include_cover: false, include_toc: false, summary: "   " },
        5,
      ),
    ).toBe(false);
  });
});

describe("renderFrontMatter", () => {
  it("produces a PDF", async () => {
    const { bytes, page_count } = await renderFrontMatter(OPTIONS, [
      { ...member(), start_page: 3 },
    ]);
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(page_count).toBeGreaterThanOrEqual(1);
  });

  it("is a single page when only the cover is switched on", async () => {
    const { page_count } = await renderFrontMatter(
      { ...OPTIONS, include_toc: false, include_summary: false },
      [],
    );
    expect(page_count).toBe(1);
  });
});

describe("buildFrontMatter", () => {
  it("prints page numbers that match the front matter it produced", async () => {
    const { page_count, entries } = await buildFrontMatter(OPTIONS, [
      member({ document_id: 1, selected_pages: [1, 2] }),
      member({ document_id: 2, page_count: 4, selected_pages: [1, 2, 3, 4] }),
    ]);
    expect(entries[0].start_page).toBe(page_count + 1);
    expect(entries[1].start_page).toBe(page_count + 3);
  });

  it("stays consistent once the contents itself spans several pages", async () => {
    // The number printed in the contents depends on how long the contents is,
    // and long contents is exactly where a one-pass implementation is wrong.
    const members = Array.from({ length: 60 }, (_, i) =>
      member({
        document_id: i + 1,
        title: `Dokument Nummer ${i + 1} mit einem eher langen Titel`,
        page_count: 2,
        selected_pages: [1, 2],
      }),
    );
    const { page_count, entries } = await buildFrontMatter(OPTIONS, members);
    expect(page_count).toBeGreaterThan(2);
    expect(entries[0].start_page).toBe(page_count + 1);
    expect(entries.at(-1)!.start_page).toBe(page_count + 1 + 59 * 2);
  });
});
