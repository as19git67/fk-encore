import { describe, expect, it } from "vitest";
import { isGenericPlaceName } from "./recaps.service";

describe("isGenericPlaceName", () => {
  it("flags generic district / city-centre names case-insensitively", () => {
    for (const name of [
      "Innere Stadt",
      "innere stadt",
      "  Altstadt ",
      "Neustadt",
      "Zentrum",
      "Innenstadt",
      "Stadtmitte",
      "Old Town",
      "Downtown",
      "City Center",
    ]) {
      expect(isGenericPlaceName(name)).toBe(true);
    }
  });

  it("keeps real place names", () => {
    for (const name of ["Wien", "Berlin", "Rom", "Neustadt an der Weinstraße", "Hamburg"]) {
      expect(isGenericPlaceName(name)).toBe(false);
    }
  });

  it("treats empty / nullish as not generic", () => {
    expect(isGenericPlaceName(null)).toBe(false);
    expect(isGenericPlaceName(undefined)).toBe(false);
    expect(isGenericPlaceName("")).toBe(false);
    expect(isGenericPlaceName("   ")).toBe(false);
  });
});
