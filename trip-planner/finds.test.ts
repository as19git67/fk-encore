/**
 * Bringing your own finds into the pool (§9.2).
 *
 * Two decisions, both of which go quietly wrong rather than loudly: a
 * find filed under the wrong leg turns up on the wrong week, and a
 * duplicate that was not recognised leaves two entries competing
 * against each other in the same pool.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_LEG_DISTANCE_M,
  SAME_PLACE_METRES,
  chooseLeg,
  findDuplicate,
  isManualRef,
  manualRef,
} from "./finds";

/** Invented anchors far enough apart to be different cities. */
const WEST = { lat: 48.37, lon: 10.9 };
const EAST = { lat: 48.14, lon: 11.58 };
const FAR = { lat: 35.68, lon: 139.69 };

const legs = [
  { position: 0, title: "Weststadt", anchor: WEST },
  { position: 1, title: "Oststadt", anchor: EAST },
];

describe("which leg a find belongs to", () => {
  it("files it by where it is, not by which leg you are looking at", () => {
    // The whole point (§9.2): a café in the eastern city goes into the
    // eastern leg even while you are standing in the west.
    expect(chooseLeg({ lat: 48.141, lon: 11.581 }, legs).position).toBe(1);
    expect(chooseLeg({ lat: 48.371, lon: 10.901 }, legs).position).toBe(0);
  });

  it("asks rather than guessing when it belongs to none of them", () => {
    // Dropping it into the nearest leg would put a find on entirely the
    // wrong week.
    const choice = chooseLeg(FAR, legs);
    expect(choice.position).toBeNull();
    expect(choice.reason).toBe("too-far");
    expect(choice.distanceM).toBeGreaterThan(MAX_LEG_DISTANCE_M);
  });

  it("keeps a day trip out of town with its city", () => {
    // An hour out is still that city's leg — the anchor is a hotel, not
    // the centroid of everything planned.
    const dayTrip = { lat: 48.9, lon: 10.9 };
    expect(chooseLeg(dayTrip, legs).position).toBe(0);
  });

  it("says so when there are no legs at all", () => {
    expect(chooseLeg(WEST, []).reason).toBe("no-legs");
  });

  it("reports how far it landed from the anchor", () => {
    const choice = chooseLeg({ lat: 48.371, lon: 10.901 }, legs);
    expect(choice.distanceM).toBeGreaterThan(0);
    expect(choice.distanceM).toBeLessThan(200);
  });
});

describe("whether a find is already there", () => {
  const existing = [
    { osmRef: "node:1", name: "Stadtmuseum Beispielstadt", lat: 48.3710, lon: 10.9010 },
    { osmRef: "node:2", name: "Rathaus", lat: 48.3800, lon: 10.9100 },
  ];

  it("settles it outright on an OSM reference", () => {
    const dup = findDuplicate({ osmRef: "node:1", lat: 0, lon: 0 }, existing);
    expect(dup?.osmRef).toBe("node:1");
  });

  it("matches a near coordinate with the same name", () => {
    // A map app's coordinate for a building, and OSM's entrance node,
    // sit tens of metres apart.
    const dup = findDuplicate(
      { name: "Stadtmuseum Beispielstadt", lat: 48.3713, lon: 10.9012 },
      existing,
    );
    expect(dup?.osmRef).toBe("node:1");
  });

  it("forgives case and spacing, and nothing beyond that", () => {
    expect(
      findDuplicate({ name: "  stadtmuseum   BEISPIELSTADT ", lat: 48.3710, lon: 10.9010 }, existing),
    ).not.toBeNull();
    // A different place that merely sounds similar is a different place.
    expect(
      findDuplicate({ name: "Stadtmuseum Musterstadt", lat: 48.3710, lon: 10.9010 }, existing),
    ).toBeNull();
  });

  it("does not merge on proximity alone", () => {
    // Two museums sharing a courtyard are two museums.
    const dup = findDuplicate({ name: "Kunsthalle", lat: 48.3711, lon: 10.9011 }, existing);
    expect(dup).toBeNull();
  });

  it("does not merge on a name alone", () => {
    // Every leg has a Rathaus.
    const dup = findDuplicate({ name: "Rathaus", lat: 48.5000, lon: 11.2000 }, existing);
    expect(dup).toBeNull();
  });

  it("cannot match a find with no name and no reference", () => {
    expect(findDuplicate({ lat: 48.3710, lon: 10.9010 }, existing)).toBeNull();
    expect(findDuplicate({ name: "   ", lat: 48.3710, lon: 10.9010 }, existing)).toBeNull();
  });

  it("treats the distance as a ceiling, not a suggestion", () => {
    const near = { name: "Rathaus", lat: 48.3800, lon: 10.9100 };
    expect(findDuplicate(near, existing)).not.toBeNull();
    // Roughly twice the ceiling to the north.
    const far = {
      name: "Rathaus",
      lat: 48.3800 + (SAME_PLACE_METRES * 2) / 111_320,
      lon: 10.9100,
    };
    expect(findDuplicate(far, existing)).toBeNull();
  });
});

describe("a find with no OSM entry behind it", () => {
  it("gets a reference that says so", () => {
    // Everything downstream reads an osmRef as "this is what
    // OpenStreetMap calls it". A made-up node id would be a claim the
    // data does not support.
    const ref = manualRef("abc123");
    expect(ref).toBe("manual:abc123");
    expect(isManualRef(ref)).toBe(true);
    expect(isManualRef("node:42")).toBe(false);
  });
});
