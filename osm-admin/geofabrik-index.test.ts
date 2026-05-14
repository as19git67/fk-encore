import { describe, expect, it } from "vitest";
import {
  parseIndex,
  pickSmallestMatchingRegion,
  pointInPolygon,
  type GeofabrikIndex,
} from "./geofabrik-index";

// Synthetic 3-region index covering a coarse "Europe / Germany / Bayern"
// nesting. Each polygon is a simple square so the point-in-polygon test
// is deterministic without depending on real OSM data.
function buildFixture(): GeofabrikIndex {
  const raw = JSON.stringify({
    features: [
      {
        properties: {
          id: "europe",
          name: "Europe",
          urls: { pbf: "https://example.com/europe.osm.pbf" },
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-10, 35],
              [40, 35],
              [40, 70],
              [-10, 70],
              [-10, 35],
            ],
          ],
        },
      },
      {
        properties: {
          id: "europe/germany",
          name: "Germany",
          parent: "europe",
          urls: { pbf: "https://example.com/germany.osm.pbf" },
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [6, 47],
              [15, 47],
              [15, 55],
              [6, 55],
              [6, 47],
            ],
          ],
        },
      },
      {
        properties: {
          id: "europe/germany/bayern",
          name: "Bayern",
          parent: "europe/germany",
          urls: { pbf: "https://example.com/bayern.osm.pbf" },
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [9, 47.5],
              [13.5, 47.5],
              [13.5, 50.5],
              [9, 50.5],
              [9, 47.5],
            ],
          ],
        },
      },
      {
        // Region with a hole — used to verify the hole-aware
        // point-in-polygon test.
        properties: {
          id: "test/donut",
          name: "Donut",
          urls: { pbf: "https://example.com/donut.osm.pbf" },
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
              [0, 0],
            ],
            // Hole punched in the middle.
            [
              [4, 4],
              [6, 4],
              [6, 6],
              [4, 6],
              [4, 4],
            ],
          ],
        },
      },
      {
        // A region with no usable geometry — must be silently dropped.
        properties: { id: "broken", name: "Broken" },
      },
    ],
  });
  return parseIndex(raw, new Date("2026-01-01T00:00:00Z"));
}

describe("parseIndex", () => {
  it("skips features without id / pbf URL / geometry", () => {
    const idx = buildFixture();
    expect(idx.regions.map((r) => r.id)).toEqual([
      "europe",
      "europe/germany",
      "europe/germany/bayern",
      "test/donut",
    ]);
  });

  it("computes bounding boxes from the geometry", () => {
    const idx = buildFixture();
    const bayern = idx.regions.find((r) => r.id === "europe/germany/bayern")!;
    expect(bayern.bbox).toEqual([9, 47.5, 13.5, 50.5]);
  });
});

describe("pointInPolygon", () => {
  it("returns true for points inside a simple polygon", () => {
    const idx = buildFixture();
    const bayern = idx.regions.find((r) => r.id === "europe/germany/bayern")!;
    // Munich ≈ (48.137, 11.575)
    expect(pointInPolygon(48.137, 11.575, bayern.geometry)).toBe(true);
  });

  it("returns false for points outside", () => {
    const idx = buildFixture();
    const bayern = idx.regions.find((r) => r.id === "europe/germany/bayern")!;
    // Hamburg ≈ (53.55, 10.0) — outside Bayern's box.
    expect(pointInPolygon(53.55, 10.0, bayern.geometry)).toBe(false);
  });

  it("respects holes (donut)", () => {
    const idx = buildFixture();
    const donut = idx.regions.find((r) => r.id === "test/donut")!;
    expect(pointInPolygon(2, 2, donut.geometry)).toBe(true); // ring
    expect(pointInPolygon(5, 5, donut.geometry)).toBe(false); // hole
  });
});

describe("pickSmallestMatchingRegion", () => {
  it("picks the most specific region in a nested hierarchy", () => {
    const idx = buildFixture();
    // Munich is inside europe, germany, and bayern. We expect bayern.
    const r = pickSmallestMatchingRegion(idx, 48.137, 11.575);
    expect(r?.id).toBe("europe/germany/bayern");
  });

  it("falls back to a less specific match when the leaf does not contain the point", () => {
    const idx = buildFixture();
    // Hamburg is in europe and germany but outside bayern.
    const r = pickSmallestMatchingRegion(idx, 53.55, 10.0);
    expect(r?.id).toBe("europe/germany");
  });

  it("returns null for points outside every region", () => {
    const idx = buildFixture();
    // Mid-Atlantic, outside the europe box.
    const r = pickSmallestMatchingRegion(idx, 25, -30);
    expect(r).toBeNull();
  });
});
