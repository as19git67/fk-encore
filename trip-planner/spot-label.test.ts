/**
 * What to call a place the map never named (§15.3).
 *
 * The rule these cases exist for is that nothing may be invented: a
 * category is not a name, so it is shown as what it is, and a spot the
 * map says nothing at all about says exactly that.
 */

import { describe, expect, it } from "vitest";
import { isUnnamed, spotLabel } from "./spot-label";

describe("the line a person reads", () => {
  it("is the name, when there is one", () => {
    expect(spotLabel({ osmRef: "way:1", name: "Sankt-Michaelis-Kirche", category: "worship" }))
      .toBe("Sankt-Michaelis-Kirche");
  });

  it("says what the map knows when the name is missing", () => {
    expect(spotLabel({ osmRef: "way:213850482", category: "worship" }))
      .toBe("Kirche (ohne Namen)");
    expect(spotLabel({ osmRef: "node:1", category: "viewpoint" }))
      .toBe("Aussichtspunkt (ohne Namen)");
  });

  it("prefers the tag when it is more precise than the category", () => {
    expect(spotLabel({ osmRef: "way:1", category: "sight", kind: "historic=ruins" }))
      .toBe("Ruine (ohne Namen)");
  });

  it("never passes a category off as a name", () => {
    // §15.3: never invent. "(ohne Namen)" is what keeps this honest.
    expect(spotLabel({ osmRef: "way:1", category: "museum" })).toContain("(ohne Namen)");
  });

  it("admits it when the map says nothing at all", () => {
    expect(spotLabel({ osmRef: "way:213850482" }))
      .toBe("Unbenannter Ort (way:213850482)");
  });

  it("treats whitespace as no name, because it reads as none", () => {
    expect(isUnnamed({ osmRef: "way:1", name: "   " })).toBe(true);
    expect(isUnnamed({ osmRef: "way:1", name: "Markt" })).toBe(false);
  });
});
