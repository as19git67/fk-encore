/**
 * Reading an article (§25, stage C): which article a link names, what
 * Wikipedia's answer turns into, and which of an article's files are
 * pictures worth showing. Every title and file is invented.
 */
import { describe, expect, it } from "vitest";
import {
  fileTitle,
  isPhotograph,
  parseArticle,
  parseArticleUrl,
  parseGermanTitle,
  parseRevision,
  parseSections,
} from "./wikipedia-client";

describe("parseArticleUrl", () => {
  it("reads the edition and the title, the mobile host included", () => {
    expect(parseArticleUrl("https://it.wikipedia.org/wiki/Chiesa_di_Esempio")).toEqual({ lang: "it", title: "Chiesa di Esempio" });
    expect(parseArticleUrl("https://de.m.wikipedia.org/wiki/Schloss_Beispiel_(Musterstadt)")).toEqual({ lang: "de", title: "Schloss Beispiel (Musterstadt)" });
    expect(parseArticleUrl("https://pt.wikipedia.org/wiki/Mosteiro_dos_Jer%C3%B3nimos")).toEqual({ lang: "pt", title: "Mosteiro dos Jerónimos" });
  });

  it("names nothing for the portal, another site, or no article", () => {
    expect(parseArticleUrl("https://www.wikipedia.org/")).toBeNull();
    expect(parseArticleUrl("https://example.test/wiki/Foo")).toBeNull();
    expect(parseArticleUrl("https://de.wikipedia.org/w/index.php?title=Foo")).toBeNull();
    expect(parseArticleUrl("not a url")).toBeNull();
  });
});

describe("parseGermanTitle", () => {
  it("finds the German article among the language links", () => {
    expect(parseGermanTitle({ query: { pages: [{ title: "Chiesa di Esempio", langlinks: [{ lang: "de", title: "Beispielkirche" }] }] } }))
      .toBe("Beispielkirche");
    expect(parseGermanTitle({ query: { pages: [{ title: "Chiesa di Esempio", langlinks: [{ lang: "fr", title: "Église" }] }] } })).toBeNull();
    expect(parseGermanTitle({ query: { pages: [{ title: "Chiesa di Esempio" }] } })).toBeNull();
    expect(parseGermanTitle({})).toBeNull();
  });
});

describe("parseSections", () => {
  it("keeps the lead, the sections and their levels, and drops the apparatus", () => {
    const extract = [
      "Die Beispielkirche ist eine Kirche in Musterstadt.",
      "",
      "Sie wurde 1203 geweiht.",
      "",
      "== Geschichte ==",
      "Der Bau begann 1180.",
      "",
      "=== Barock ===",
      "1720 kam der Turm dazu.",
      "",
      "== Galerie ==",
      "",
      "== Einzelnachweise ==",
      "1. Beispielbuch, S. 12.",
      "",
      "== Weblinks ==",
      "Offizielle Seite",
    ].join("\n");
    expect(parseSections(extract)).toEqual([
      { heading: null, level: 1, text: "Die Beispielkirche ist eine Kirche in Musterstadt.\n\nSie wurde 1203 geweiht." },
      { heading: "Geschichte", level: 2, text: "Der Bau begann 1180." },
      { heading: "Barock", level: 3, text: "1720 kam der Turm dazu." },
    ]);
  });

  it("drops a subsection that is apparatus without dropping what follows", () => {
    const extract = "Lead.\n\n== Bau ==\nText.\n\n=== Literatur ===\nBuch.\n\n=== Turm ===\nHoch.\n";
    expect(parseSections(extract).map((s) => s.heading)).toEqual([null, "Bau", "Turm"]);
  });

  it("is empty for an empty extract", () => {
    expect(parseSections("")).toEqual([]);
  });
});

describe("the article's files", () => {
  it("spells every namespace as Commons does", () => {
    expect(fileTitle("Datei:Beispielkirche_Westfassade.jpg")).toBe("File:Beispielkirche Westfassade.jpg");
    expect(fileTitle("Fichier:Église.jpg")).toBe("File:Église.jpg");
    expect(fileTitle("Beispielkirche.jpg")).toBe("File:Beispielkirche.jpg");
    expect(fileTitle("File:Already.jpg")).toBe("File:Already.jpg");
  });

  it("keeps photographs and drops icons, flags, maps and vector graphics", () => {
    expect(isPhotograph("File:Beispielkirche Westfassade.jpg")).toBe(true);
    expect(isPhotograph("File:Innenraum 2019.JPG")).toBe(true);
    expect(isPhotograph("File:Flag of Italy.svg")).toBe(false);
    expect(isPhotograph("File:Commons-logo.svg")).toBe(false);
    expect(isPhotograph("File:Musterstadt map.png")).toBe(false);
    expect(isPhotograph("File:Wappen Musterstadt.png")).toBe(false);
    expect(isPhotograph("File:Glocke.ogg")).toBe(false);
  });

  it("builds the article with its pictures, the main one first", () => {
    const article = parseArticle({
      query: {
        pages: [{
          title: "Beispielkirche",
          fullurl: "https://de.wikipedia.org/wiki/Beispielkirche",
          lastrevid: 4711,
          description: "Kirche in Musterstadt",
          extract: "Lead.\n\n== Geschichte ==\nText.",
          pageimage: "Beispielkirche_Westfassade.jpg",
          images: [
            { title: "Datei:Flag of Italy.svg" },
            { title: "Datei:Innenraum.jpg" },
            { title: "Datei:Beispielkirche_Westfassade.jpg" },
          ],
        }],
      },
    }, "de");
    expect(article).toMatchObject({
      lang: "de",
      title: "Beispielkirche",
      description: "Kirche in Musterstadt",
      mainImage: "File:Beispielkirche Westfassade.jpg",
      images: ["File:Beispielkirche Westfassade.jpg", "File:Innenraum.jpg"],
      revision: 4711,
    });
    expect(article?.sections).toHaveLength(2);
    expect(parseRevision({ query: { pages: [{ title: "Beispielkirche", lastrevid: 4712 }] } })).toBe(4712);
    expect(parseRevision({ query: { pages: [{ title: "Nichts", missing: true }] } })).toBeNull();
    expect(parseArticle({ query: { pages: [{ title: "Nichts", missing: true }] } }, "de")).toBeNull();
  });
});
