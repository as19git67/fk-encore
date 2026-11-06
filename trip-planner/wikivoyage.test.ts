import { describe, expect, it } from "vitest";
import { cleanText, listingFor, parseListings } from "./wikivoyage";

// An invented city: every name, id and coordinate here is made up.
const PAGE = `
== Sehenswürdigkeiten ==
=== Kirchen ===
* {{vCard |type=cathedral |name=Musterdom |wikidata=Q999001 |lat=48.1000 |long=11.5000
 |description=Gotische Kathedrale mit dem höchsten Turm der [[Musterstadt|Stadt]]; '''Turmbesteigung''' lohnt sich. {{Bpl|x}}
}}
* {{vCard |type=bridge |name=Alte Brücke |lat=48.1010 |long=11.5020 |description=}}
== Essen ==
* {{vCard |type=restaurant |name=Gasthaus Beispiel |lat=48.1 |long=11.5 |description=Gut bürgerlich.}}
== Aktivitäten ==
* {{do | name=Stadtrundgang Musterstadt | content=Zwei Stunden durch die [https://example.test Altstadt]. }}
`;

describe("parseListings", () => {
  it("reads the sights and leaves beds and meals out", () => {
    const listings = parseListings(PAGE);
    expect(listings.map((l) => l.name)).toEqual(["Musterdom", "Alte Brücke", "Stadtrundgang Musterstadt"]);
    expect(listings[0]).toMatchObject({ qid: "Q999001", lat: 48.1, lon: 11.5 });
    expect(listings[0].description).toBe(
      "Gotische Kathedrale mit dem höchsten Turm der Stadt; Turmbesteigung lohnt sich.",
    );
    expect(listings[1].description).toBeNull();
    expect(listings[2].description).toBe("Zwei Stunden durch die Altstadt.");
  });
});

describe("listingFor", () => {
  const listings = parseListings(PAGE);

  it("matches by Wikidata id first", () => {
    expect(listingFor({ name: "Dom", qid: "Q999001", lat: 0, lon: 0 }, listings)?.name).toBe("Musterdom");
  });

  it("matches by name only when the listing is close by", () => {
    expect(listingFor({ name: "Alte Brücke", qid: null, lat: 48.1011, lon: 11.5021 }, listings)?.name)
      .toBe("Alte Brücke");
    // Every town has an "Alte Brücke"; the one two kilometres away is another.
    expect(listingFor({ name: "Alte Brücke", qid: null, lat: 48.12, lon: 11.5 }, listings)).toBeNull();
  });
});

describe("cleanText", () => {
  it("cuts at a sentence where it can", () => {
    const long = `${"Ein Satz über den Ort. ".repeat(20)}`;
    const cut = cleanText(long, 100)!;
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.endsWith(".")).toBe(true);
  });
});
