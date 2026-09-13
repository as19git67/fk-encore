/**
 * The questions a browse can answer (§3.1, §7.2).
 *
 * What matters is the middle case. A place that is half covered is a
 * real answer to rain and a real answer to sunshine, and the two ways
 * of getting it wrong — dropping it, or presenting it as though it
 * were shelter — are both worse than saying "teils".
 */

import { describe, expect, it } from "vitest";
import { answer, isExploreQuestion, questionLabel } from "./explore-questions";

const museum = { category: "museum", kind: "tourism=museum", dwellMinutes: 90 };
const viewpoint = { category: "viewpoint", kind: "tourism=viewpoint", dwellMinutes: 20 };
/** Half inside, half not — a castle is the case the middle value exists for. */
const castle = { category: "sight", kind: "historic=castle", dwellMinutes: 45 };

describe("bei Regen", () => {
  it("keeps what is indoors", () => {
    expect(answer("rain", museum)).toMatchObject({ keep: true, note: "innen" });
  });

  it("drops what is not", () => {
    expect(answer("rain", viewpoint).keep).toBe(false);
  });

  it("keeps the half-covered and says so", () => {
    const half = answer("rain", castle);
    expect(half.keep).toBe(true);
    expect(half.note).toBe("teils überdacht");
    // Behind the wholly indoor ones, because on a wet afternoon they
    // are not equally good answers.
    expect(half.rank).toBeGreaterThan(answer("rain", museum).rank);
  });
});

describe("bei schönem Wetter", () => {
  it("is the same derivation read the other way", () => {
    expect(answer("fair", viewpoint)).toMatchObject({ keep: true, note: "draußen" });
    expect(answer("fair", museum).keep).toBe(false);
    expect(answer("fair", castle)).toMatchObject({ keep: true, note: "teils draußen" });
  });
});

describe("nur kurz", () => {
  it("keeps what fits in half an hour, and names the figure", () => {
    expect(answer("quick", viewpoint)).toMatchObject({ keep: true, note: "etwa 20 Minuten" });
  });

  it("drops what does not", () => {
    expect(answer("quick", museum).keep).toBe(false);
    // The boundary belongs to the shorter side: half an hour is half an
    // hour.
    expect(answer("quick", { ...museum, dwellMinutes: 30 }).keep).toBe(true);
    expect(answer("quick", { ...museum, dwellMinutes: 31 }).keep).toBe(false);
  });
});

describe("the vocabulary", () => {
  it("recognises only the questions it can answer", () => {
    expect(isExploreQuestion("rain")).toBe(true);
    expect(isExploreQuestion("monday")).toBe(false);
    // No opening-hours parser, so no question that would need one.
    expect(isExploreQuestion("open")).toBe(false);
  });

  it("says each question the way the chip does", () => {
    expect(questionLabel("rain")).toBe("bei Regen");
    expect(questionLabel("quick")).toContain("halben Stunde");
  });
});
