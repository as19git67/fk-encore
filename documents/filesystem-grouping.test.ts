import path from "path";
import { describe, expect, it } from "vitest";
import {
  type DocumentLocationContext,
  resolveDocumentDiskPath,
  resolveSubjectPersonGroupingSegment,
} from "./documents.service";
import { categoryTaxonomy, filesystemGroupingForCategoryPath } from "./taxonomy";

describe("filesystem category grouping", () => {
  it("contains the Vereine root and its two focused children", () => {
    const vereine = categoryTaxonomy.find((category) => category.slug === "vereine");
    expect(vereine?.name).toBe("Vereine");
    expect(vereine?.children?.map((child) => child.slug)).toEqual([
      "vereine-urkunden",
      "vereine-mitgliedschaft",
    ]);
    expect(vereine?.children?.[0]?.hint).toContain("Feuerwehr");
    expect(vereine?.children?.[1]?.hint).toContain("Aufnahmeanträge");
  });

  it("contains the Familienleistungen category below Familie", () => {
    const familie = categoryTaxonomy.find((category) => category.slug === "familie");
    const familienleistungen = familie?.children?.find(
      (child) => child.slug === "familie-familienleistungen",
    );
    expect(familienleistungen?.name).toBe("Familienleistungen");
    expect(familienleistungen?.hint).toContain("Kindergeldbescheid");
  });

  it("declares required Betreuung and optional person-aware roots", () => {
    expect(filesystemGroupingForCategoryPath([
      "betreuung",
      "betreuung-rechenschaftsbericht",
    ])).toEqual({
      categorySlug: "betreuung",
      config: {
        source: "subject_person",
        missingSegment: "_ohne-betreuten",
        multipleSegment: "_mehrere-betreute",
      },
    });
    for (const slug of ["gesundheit", "familie", "vereine", "bildung"]) {
      expect(filesystemGroupingForCategoryPath([slug])?.config).toEqual({
        source: "subject_person",
        multipleSegment: "_mehrere-bezugspersonen",
      });
    }
    expect(filesystemGroupingForCategoryPath(["finanzen"])).toBeNull();
  });

  it("resolves one, missing and multiple linked people deterministically", () => {
    expect(resolveSubjectPersonGroupingSegment(["Erika Mustermann"], {}))
      .toBe("erika-mustermann");
    expect(resolveSubjectPersonGroupingSegment([], {})).toBeNull();
    expect(resolveSubjectPersonGroupingSegment([], {
      missingSegment: "_ohne-betreuten",
    })).toBe("_ohne-betreuten");
    expect(resolveSubjectPersonGroupingSegment(
      ["Zoe Beispiel", "Anna Beispiel"],
      { multipleSegment: "_mehrere-betreute" },
    )).toBe("_mehrere-betreute");
  });

  it("inserts the resolved dimension directly below its configured root", () => {
    const ctx: DocumentLocationContext = {
      visibility: "private",
      userLoginSlug: "anton",
      groupSlug: null,
      categorySlugs: ["betreuung", "betreuung-rechenschaftsbericht"],
      filesystemGrouping: {
        afterCategorySlug: "betreuung",
        segment: "erika-mustermann",
      },
      correspondentSlug: "amtsgericht-augsburg",
      status: "ready",
      docDate: "2026-07-15",
      documentNumber: null,
      uploadedAt: new Date("2026-07-15T10:00:00Z"),
      sender: "Amtsgericht Augsburg",
      title: "Rechenschaftsbericht",
      originalFilename: "scan.pdf",
      sha256: "1234567890abcdef",
      ext: ".pdf",
    };

    const result = resolveDocumentDiskPath(ctx);
    expect(result.relPath).toBe(path.join(
      "anton",
      "betreuung",
      "erika-mustermann",
      "betreuung-rechenschaftsbericht",
      "amtsgericht-augsburg",
      "2026_amtsgericht-augsburg_rechenschaftsbericht__12345678.pdf",
    ));
  });
});
