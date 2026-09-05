import { describe, expect, it } from "vitest";
import {
  MAX_AMBIGUOUS_OPTIONS,
  resolvePlace,
  type PlaceCandidate,
} from "./resolve-place";

function candidate(over: Partial<PlaceCandidate> & { osmRef: string }): PlaceCandidate {
  return {
    name: null,
    nameDe: null,
    nameEn: null,
    lat: 38.71,
    lon: -9.14,
    distanceM: null,
    categories: [],
    ...over,
  };
}

describe("resolvePlace", () => {
  it("takes the single match", () => {
    const museum = candidate({ osmRef: "node:1", name: "Stadtmuseum Beispielstadt" });
    const result = resolvePlace("Stadtmuseum", [museum]);
    expect(result.verdict).toBe("unique");
    expect(result.match?.osmRef).toBe("node:1");
    expect(result.options).toEqual([]);
  });

  it("finds a place whose name lost its accents on the way", () => {
    const cafe = candidate({ osmRef: "node:2", name: "Café Zentral" });
    expect(resolvePlace("cafe zentral", [cafe]).match?.osmRef).toBe("node:2");
  });

  it("matches the name an English article would use", () => {
    const museum = candidate({
      osmRef: "node:3",
      name: "Stadtmuseum Beispielstadt",
      nameEn: "Example City Museum",
    });
    expect(resolvePlace("Example City Museum", [museum]).match?.osmRef).toBe("node:3");
  });

  it("lets an exact match beat the rows that merely contain the word", () => {
    // The case the two rounds exist for. "Museum am Platz" is exactly
    // what the article said; "Stadtmuseum am Platz und Umgebung"
    // contains it. One round over both would call this ambiguous and
    // ask a question with an obvious answer.
    const exact = candidate({ osmRef: "node:4", name: "Museum am Platz" });
    const longer = candidate({ osmRef: "node:5", name: "Museum am Platz und Umgebung" });
    const result = resolvePlace("Museum am Platz", [exact, longer]);
    expect(result.verdict).toBe("unique");
    expect(result.match?.osmRef).toBe("node:4");
  });

  it("asks when several places are exactly that name", () => {
    // Three branches of one café is the ordinary case, not an error —
    // and picking the nearest would silently plan the wrong one.
    const options = [
      candidate({ osmRef: "node:7", name: "Café Beispiel", distanceM: 900 }),
      candidate({ osmRef: "node:6", name: "Café Beispiel", distanceM: 120 }),
      candidate({ osmRef: "node:8", name: "Café Beispiel", distanceM: 400 }),
    ];
    const result = resolvePlace("Café Beispiel", options);
    expect(result.verdict).toBe("ambiguous");
    expect(result.match).toBeNull();
    expect(result.options.map((o) => o.osmRef)).toEqual(["node:6", "node:8", "node:7"]);
  });

  it("puts places of unknown distance behind the ones it can measure", () => {
    const result = resolvePlace("Kiosk", [
      candidate({ osmRef: "node:9", name: "Kiosk", distanceM: null }),
      candidate({ osmRef: "node:10", name: "Kiosk", distanceM: 5000 }),
    ]);
    expect(result.options.map((o) => o.osmRef)).toEqual(["node:10", "node:9"]);
  });

  it("orders equally distant options the same way every time", () => {
    const same = [
      candidate({ osmRef: "node:12", name: "Brunnen", distanceM: 100 }),
      candidate({ osmRef: "node:11", name: "Brunnen", distanceM: 100 }),
    ];
    expect(resolvePlace("Brunnen", same).options.map((o) => o.osmRef))
      .toEqual(["node:11", "node:12"]);
  });

  it("caps how long a question may get", () => {
    const many = Array.from({ length: MAX_AMBIGUOUS_OPTIONS + 4 }, (_, i) =>
      candidate({ osmRef: `node:${100 + i}`, name: "Bäckerei", distanceM: i * 10 }));
    const result = resolvePlace("Bäckerei", many);
    expect(result.verdict).toBe("ambiguous");
    expect(result.options).toHaveLength(MAX_AMBIGUOUS_OPTIONS);
  });

  it("answers none rather than reaching for the closest thing", () => {
    const result = resolvePlace("Taberna do Exemplo", [
      candidate({ osmRef: "node:20", name: "Stadtmuseum Beispielstadt", distanceM: 30 }),
    ]);
    expect(result.verdict).toBe("none");
    expect(result.match).toBeNull();
    expect(result.options).toEqual([]);
  });

  it("treats a blank name as no name at all", () => {
    const anything = candidate({ osmRef: "node:21", name: "Irgendwas" });
    // A folded empty string is a substring of everything, so without
    // this guard a blank name would match the first row and look
    // confident about it.
    expect(resolvePlace("   ", [anything]).verdict).toBe("none");
  });

  it("ignores candidates with no name at all", () => {
    const unnamed = candidate({ osmRef: "node:22" });
    const named = candidate({ osmRef: "node:23", name: "Aussichtspunkt" });
    expect(resolvePlace("Aussichtspunkt", [unnamed, named]).match?.osmRef).toBe("node:23");
  });
});
