/**
 * Tag names as people say them in a question resolve to the user's tags,
 * so "außer Umbuchungen" leaves the tag "Umbuchung" out instead of nothing.
 */

import { describe, it, expect } from "vitest";
import { resolveTagNames } from "./tools/finance";

const KNOWN = ["Umbuchung", "Lebensmittel", "Auto", "Versicherungen"];

describe("resolveTagNames", () => {
  it("takes a tag as it is, in other case, or in singular or plural", () => {
    expect(resolveTagNames(["Auto"], KNOWN)).toEqual(["Auto"]);
    expect(resolveTagNames(["lebensmittel"], KNOWN)).toEqual(["Lebensmittel"]);
    expect(resolveTagNames(["Umbuchungen"], KNOWN)).toEqual(["Umbuchung"]);
    expect(resolveTagNames(["Versicherung"], KNOWN)).toEqual(["Versicherungen"]);
  });

  it("names the user's tags when a name matches none", () => {
    expect(() => resolveTagNames(["Urlaub"], KNOWN)).toThrow(/no tag "Urlaub"; the user's tags are "Umbuchung", "Lebensmittel"/);
  });

  it("asks which one when a name could mean two tags", () => {
    expect(() => resolveTagNames(["Spend"], ["Spende", "Spenden"])).toThrow(/could mean "Spende" or "Spenden"/);
  });
});
