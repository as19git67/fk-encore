import { describe, expect, it } from "vitest";
import {
  MAX_EXTRACTED_PLACES,
  MAX_NAME_CHARS,
  buildExtractPrompt,
  parseExtractedPlaces,
} from "./extract-places";

/** An invented travel article — no real places, no real businesses. */
const ARTICLE = [
  "Zehn Orte in Beispielstadt, die sich lohnen.",
  "Im Beispielcafé in der Altstadt gibt es den besten Kuchen der Stadt.",
  "Das Stadtmuseum am Musterplatz füllt einen ganzen Vormittag.",
  "Wer Aussicht sucht, steigt auf den Beispielberg.",
].join("\n");

describe("parseExtractedPlaces", () => {
  it("keeps the entries whose quotes are really in the page", () => {
    const { places, rejected } = parseExtractedPlaces([
      {
        name: "Beispielcafé",
        placeHint: "in der Altstadt",
        category: "Café",
        quote: "gibt es den besten Kuchen der Stadt",
      },
      {
        name: "Stadtmuseum",
        quote: "füllt einen ganzen Vormittag",
      },
    ], ARTICLE);

    expect(rejected).toEqual([]);
    expect(places).toHaveLength(2);
    expect(places[0]).toEqual({
      name: "Beispielcafé",
      placeHint: "in der Altstadt",
      kindHint: "Café",
      quote: "gibt es den besten Kuchen der Stadt",
    });
    expect(places[1].placeHint).toBeNull();
    expect(places[1].kindHint).toBeNull();
  });

  it("drops a place the page never mentioned", () => {
    // The whole design turns on this: a model that invents a
    // recommendation cannot invent a quote that is in the page.
    const { places, rejected } = parseExtractedPlaces([
      { name: "Taberna Erfunden", quote: "die schönste Taberna der Altstadt" },
      { name: "Beispielberg", quote: "Wer Aussicht sucht, steigt auf den Beispielberg" },
    ], ARTICLE);

    expect(places.map((p) => p.name)).toEqual(["Beispielberg"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("Taberna Erfunden");
    expect(rejected[0]).toContain("Zitat");
  });

  it("drops an entry that came without a quote at all", () => {
    const { places, rejected } = parseExtractedPlaces(
      [{ name: "Stadtmuseum" }],
      ARTICLE,
    );
    expect(places).toEqual([]);
    expect(rejected[0]).toContain("ohne Zitat");
  });

  it("accepts the list however the model wrapped it", () => {
    const entry = { name: "Stadtmuseum", quote: "füllt einen ganzen Vormittag" };
    for (const raw of [
      [entry],
      { places: [entry] },
      { orte: [entry] },
      { results: [entry] },
    ]) {
      expect(parseExtractedPlaces(raw, ARTICLE).places).toHaveLength(1);
    }
  });

  it("says so when the answer was not a list at all", () => {
    const { places, rejected } = parseExtractedPlaces("Hier sind zehn Cafés!", ARTICLE);
    expect(places).toEqual([]);
    expect(rejected).toHaveLength(1);
  });

  it("skips a broken entry without losing the good ones", () => {
    const { places, rejected } = parseExtractedPlaces([
      "nur ein String",
      { quote: "füllt einen ganzen Vormittag" },
      { name: 42, quote: "füllt einen ganzen Vormittag" },
      { name: "Stadtmuseum", quote: "füllt einen ganzen Vormittag" },
    ], ARTICLE);

    expect(places.map((p) => p.name)).toEqual(["Stadtmuseum"]);
    expect(rejected).toHaveLength(3);
  });

  it("names each place once, however often the article does", () => {
    const { places } = parseExtractedPlaces([
      { name: "Stadtmuseum", quote: "füllt einen ganzen Vormittag" },
      { name: "stadtmuseum", quote: "Das Stadtmuseum am Musterplatz" },
    ], ARTICLE);
    expect(places).toHaveLength(1);
  });

  it("caps a listing and says how much it left", () => {
    const many = Array.from({ length: MAX_EXTRACTED_PLACES + 3 }, (_, i) => ({
      name: `Ort ${i}`,
      quote: "füllt einen ganzen Vormittag",
    }));
    const { places, rejected } = parseExtractedPlaces(many, ARTICLE);

    expect(places).toHaveLength(MAX_EXTRACTED_PLACES);
    expect(rejected.join(" ")).toContain("3 weitere");
  });

  it("trims a name that is really a sentence", () => {
    const long = "M".repeat(MAX_NAME_CHARS + 50);
    const { places } = parseExtractedPlaces(
      [{ name: long, quote: "füllt einen ganzen Vormittag" }],
      ARTICLE,
    );
    expect(places[0].name).toHaveLength(MAX_NAME_CHARS);
  });
});

describe("buildExtractPrompt", () => {
  it("asks for exactly the fields the parser reads", () => {
    // A field renamed on one side only would extract nothing, and the
    // symptom looks identical to a page with no places on it.
    const prompt = buildExtractPrompt(ARTICLE);
    for (const field of ["name", "placeHint", "category", "quote"]) {
      expect(prompt).toContain(`"${field}"`);
    }
  });

  it("carries the page and the rule the check enforces", () => {
    const prompt = buildExtractPrompt(ARTICLE);
    expect(prompt).toContain(ARTICLE);
    expect(prompt).toContain("WÖRTLICHES Zitat");
    expect(prompt).toContain("Erfinde nichts");
  });
});
