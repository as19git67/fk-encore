import { describe, expect, it } from "vitest";
import { addDays, comboKey, rotationPick, stayCombinations } from "./flexible-dates";

describe("flexible dates", () => {
  it("lists every stay in the window, earliest start and shortest stay first", () => {
    const combos = stayCombinations({ from: "2027-05-01", to: "2027-05-06", minNights: 3, maxNights: 4, today: "2026-11-12" });
    expect(combos.map(comboKey)).toEqual([
      "2027-05-01|2027-05-04",
      "2027-05-01|2027-05-05",
      "2027-05-02|2027-05-05",
      "2027-05-02|2027-05-06",
      "2027-05-03|2027-05-06",
    ]);
  });

  it("drops starts that have begun and lists one-way days without an end", () => {
    const combos = stayCombinations({ from: "2027-05-01", to: "2027-05-03", minNights: null, maxNights: null, today: "2027-05-01" });
    expect(combos).toEqual([
      { start: "2027-05-02", end: null },
      { start: "2027-05-03", end: null },
    ]);
  });

  it("walks the combinations in turn and starts over", () => {
    const combos = stayCombinations({ from: "2027-05-01", to: "2027-05-03", minNights: null, maxNights: null, today: "2026-11-12" });
    expect(rotationPick(combos, -1)?.index).toBe(0);
    expect(rotationPick(combos, 1)?.combo.start).toBe("2027-05-03");
    expect(rotationPick(combos, 2)?.index).toBe(0);
    expect(rotationPick([], 0)).toBeNull();
  });

  it("adds days across a month", () => {
    expect(addDays("2027-02-27", 3)).toBe("2027-03-02");
  });
});
