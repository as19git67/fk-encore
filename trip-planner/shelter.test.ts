import { describe, expect, it } from "vitest";
import { exposure, shelterOf } from "./shelter";

describe("whether a spot keeps the rain off", () => {
  it("reads the tag a mapper wrote", () => {
    expect(shelterOf("sight", "building=church")).toBe("indoor");
    expect(shelterOf("sight", "leisure=park")).toBe("outdoor");
  });

  it("lets the tag overrule the category", () => {
    // "sight" holds cathedrals and market squares alike; the tag is
    // what somebody actually said about this one place.
    expect(shelterOf("sight", "tourism=museum")).toBe("indoor");
    expect(shelterOf("museum", "historic=ruins")).toBe("outdoor");
  });

  it("falls back to the category when the tag says nothing", () => {
    expect(shelterOf("museum", null)).toBe("indoor");
    expect(shelterOf("viewpoint", undefined)).toBe("outdoor");
    expect(shelterOf("theatre", "amenity=something_new")).toBe("indoor");
  });

  it("knows that nothing natural is indoors", () => {
    expect(shelterOf("sight", "natural=cliff")).toBe("outdoor");
    expect(shelterOf("museum", "natural=spring")).toBe("outdoor");
  });

  it("shrugs honestly rather than guessing", () => {
    // A category nobody has an opinion about is half outside, which is
    // the truthful answer and not a default dressed up as knowledge.
    expect(shelterOf("essentials", null)).toBe("partly");
    expect(shelterOf(null, null)).toBe("partly");
    expect(shelterOf(undefined, undefined)).toBe("partly");
  });

  it("keeps the half-outside cases genuinely in the middle", () => {
    // A castle, a market hall and a cloister are neither, and forcing
    // them either way sends a family into the rain or wastes the one
    // dry hour indoors.
    expect(shelterOf("sight", "historic=castle")).toBe("partly");
    expect(shelterOf("sight", "amenity=marketplace")).toBe("partly");
    expect(shelterOf("sight", "tourism=attraction")).toBe("partly");
  });

  it("orders the three by how much they mind the wet", () => {
    expect(exposure("indoor")).toBeLessThan(exposure("partly"));
    expect(exposure("partly")).toBeLessThan(exposure("outdoor"));
    expect(exposure("indoor")).toBe(0);
    expect(exposure("outdoor")).toBe(1);
  });
});
