/**
 * The two copies of the name folding must not drift.
 *
 * `geo/src/name-fold.ts` and `trip-planner/name-fold.ts` are the same
 * file in two build contexts that cannot import each other. Geo folds
 * names in SQL to narrow the rows; the planner folds them in JavaScript
 * to decide which of those rows is the place meant. If the two ever
 * disagree, the SQL drops rows the JavaScript would have accepted and
 * the symptom is "the search sometimes finds nothing" — a bug that
 * reads as flaky rather than as wrong.
 *
 * So this compares the bytes. It is a blunt test on purpose: anything
 * subtler (exporting a hash, comparing behaviour on a sample) would let
 * a difference through somewhere.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { foldName } from "./name-fold";

const HERE = dirname(new URL(import.meta.url).pathname);
const PLANNER_COPY = join(HERE, "name-fold.ts");
const GEO_COPY = join(HERE, "..", "geo", "src", "name-fold.ts");

describe("name folding", () => {
  it("is byte-identical in geo and in the planner", () => {
    const planner = readFileSync(PLANNER_COPY, "utf8");
    const geo = readFileSync(GEO_COPY, "utf8");
    expect(
      planner,
      "trip-planner/name-fold.ts and geo/src/name-fold.ts have drifted apart — "
        + "copy whichever one you changed over the other",
    ).toBe(geo);
  });

  it("folds the way the planner's comparisons assume", () => {
    // Not a second copy of geo's test — just enough to catch a copy
    // that arrived truncated or with its table mangled, before the
    // resolver's tests blame the resolver.
    expect(foldName("Café Zentral")).toBe("cafe zentral");
    expect(foldName("Straßenbahnmuseum")).toBe("strassenbahnmuseum");
    expect(foldName("  Museum  am  Platz  ")).toBe("museum am platz");
  });
});
