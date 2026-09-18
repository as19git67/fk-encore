import { describe, expect, it } from "vitest";
import { articleUrl, wikipediaUrl } from "./spot-links";

describe("wikipediaUrl", () => {
  it("builds the article URL from the language-prefixed tag", () => {
    expect(wikipediaUrl("de:Schloss Beispiel")).toBe(
      "https://de.wikipedia.org/wiki/Schloss_Beispiel",
    );
  });

  it("keeps the language the tag names, not the reader's", () => {
    expect(wikipediaUrl("ja:美術館")).toBe(
      "https://ja.wikipedia.org/wiki/%E7%BE%8E%E8%A1%93%E9%A4%A8",
    );
  });

  it("leaves the punctuation article titles carry unescaped", () => {
    expect(wikipediaUrl("de:Museum (Beispielstadt)")).toBe(
      "https://de.wikipedia.org/wiki/Museum_(Beispielstadt)",
    );
  });

  it("escapes what would otherwise cut the URL short", () => {
    expect(wikipediaUrl("de:Haus #1")).toBe("https://de.wikipedia.org/wiki/Haus_%231");
  });

  it("passes a full Wikipedia URL through", () => {
    expect(wikipediaUrl("https://de.wikipedia.org/wiki/Beispiel")).toBe(
      "https://de.wikipedia.org/wiki/Beispiel",
    );
  });

  it("refuses a URL that is not Wikipedia, whatever the tag claims", () => {
    // The tag is occasionally misused for the operator's homepage;
    // presenting that as an article would be a lie in a trusted place.
    expect(wikipediaUrl("https://beispiel.test/museum")).toBeNull();
    expect(wikipediaUrl("https://notwikipedia.org/wiki/Beispiel")).toBeNull();
  });

  it("says nothing when the tag has no language", () => {
    // Guessing "de" for a place in Kyoto would link an article that
    // does not exist. No link beats a wrong one.
    expect(wikipediaUrl("Schloss Beispiel")).toBeNull();
  });

  it("says nothing for an empty or missing tag", () => {
    expect(wikipediaUrl(null)).toBeNull();
    expect(wikipediaUrl(undefined)).toBeNull();
    expect(wikipediaUrl("   ")).toBeNull();
    expect(wikipediaUrl("de:  ")).toBeNull();
  });
});

describe("articleUrl (§10.4)", () => {
  it("prefers the German article where the map knows one", () => {
    // The plain tag names the Italian article; wikipedia:de names the
    // German one for the same building.
    expect(articleUrl({ wikipedia: "it:Colosseo", wikipediaDe: "Kolosseum" })).toBe(
      "https://de.wikipedia.org/wiki/Kolosseum",
    );
  });

  it("takes the German tag with its language already on it", () => {
    expect(articleUrl({ wikipedia: "it:Colosseo", wikipediaDe: "de:Kolosseum" })).toBe(
      "https://de.wikipedia.org/wiki/Kolosseum",
    );
  });

  it("takes a full URL in the German tag", () => {
    expect(articleUrl({
      wikipedia: "it:Colosseo",
      wikipediaDe: "https://de.wikipedia.org/wiki/Kolosseum",
    })).toBe("https://de.wikipedia.org/wiki/Kolosseum");
  });

  it("keeps the local article when there is no German one", () => {
    // Nothing is guessed: de.wikipedia.org/wiki/Colosseo may not
    // exist, and a link that 404s is worse than one in Italian.
    expect(articleUrl({ wikipedia: "it:Colosseo" })).toBe(
      "https://it.wikipedia.org/wiki/Colosseo",
    );
    expect(articleUrl({ wikipedia: "it:Colosseo", wikipediaDe: "   " })).toBe(
      "https://it.wikipedia.org/wiki/Colosseo",
    );
  });

  it("falls back to the local article when the German tag is nonsense", () => {
    expect(articleUrl({ wikipedia: "it:Colosseo", wikipediaDe: "https://example.test/x" })).toBe(
      "https://it.wikipedia.org/wiki/Colosseo",
    );
  });

  it("says nothing when the map knows no article at all", () => {
    expect(articleUrl({})).toBeNull();
    expect(articleUrl({ wikipedia: null, wikipediaDe: null })).toBeNull();
  });
});
