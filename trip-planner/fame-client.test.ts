import { describe, expect, it } from "vitest";
import { lastTwelveMonths, parseCategorySizes, parseItems, parsePageImages, parsePageviews, parseWikitext } from "./fame-client";

describe("fame client parsers", () => {
  it("counts Wikipedia editions only, and reads the Commons category and image", () => {
    const items = parseItems({
      entities: {
        Q999001: {
          sitelinks: { dewiki: {}, enwiki: {}, itwiki: {}, commonswiki: {}, dewikivoyage: {}, wikidatawiki: {} },
          claims: {
            P373: [{ mainsnak: { datavalue: { value: "Musterdom (Musterstadt)" } } }],
            P18: [{ mainsnak: { datavalue: { value: "Musterdom aussen.jpg" } } }],
          },
        },
        Q999002: { missing: "" },
      },
    });
    expect(items.get("Q999001")).toEqual({
      languages: 3, commonsCategory: "Musterdom (Musterstadt)", image: "File:Musterdom aussen.jpg",
    });
    expect(items.has("Q999002")).toBe(false);
  });

  it("averages the monthly page views", () => {
    expect(parsePageviews({ items: [{ views: 1_000 }, { views: 3_000 }] })).toBe(2_000);
  });

  it("reads the file count of each category", () => {
    const sizes = parseCategorySizes({ query: { pages: [
      { title: "Category:Musterdom (Musterstadt)", categoryinfo: { files: 412 } },
      { title: "Category:Gibt es nicht", missing: true },
    ] } });
    expect([...sizes]).toEqual([["Musterdom (Musterstadt)", 412]]);
  });

  it("keys a main image by the title that was asked", () => {
    const images = parsePageImages({ query: {
      normalized: [{ from: "Musterdom_(Musterstadt)", to: "Musterdom (Musterstadt)" }],
      pages: [{ title: "Musterdom (Musterstadt)", pageimage: "Musterdom_aussen.jpg" }, { title: "Ohne Bild" }],
    } });
    expect(images.get("Musterdom_(Musterstadt)")).toBe("File:Musterdom aussen.jpg");
    expect(images.has("Ohne Bild")).toBe(false);
  });

  it("reads a page's wikitext", () => {
    expect(parseWikitext({ query: { pages: [{ revisions: [{ slots: { main: { content: "== A ==" } } }] }] } }))
      .toBe("== A ==");
  });

  it("asks for the twelve full months before today", () => {
    expect(lastTwelveMonths(new Date("2026-11-06T12:00:00Z"))).toEqual({ start: "20251101", end: "20261031" });
  });
});
