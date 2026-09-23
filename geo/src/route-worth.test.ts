/**
 * Which ways are worth a day (§4.7), against a real PostGIS database.
 *
 * The weights are a matter of taste and are not what these pin down.
 * What they pin down is geometry that is easy to get quietly wrong:
 * that "along the way" means near the *line* and not near its start,
 * that a thing a kilometre off the path does not count as passed,
 * that a nameless tower (a phone mast, as often as not) does not
 * count, and that a very long way is judged on the stretch near here.
 *
 * Coordinates sit near Lake Garda; every place is invented.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  createSeededRegion,
  dropRegion,
  postgisAvailable,
  seedRoutes,
  type SeedPoi,
  type SeedRoute,
} from "./test-db.ts";
import { RouteSearchError, searchRoutes } from "./route-search.ts";
import { highlightsFrom, networkRank, routeWorth } from "./route-worth.ts";

const DB = "geo_test_route_worth";

const BASE = { lat: 45.88, lon: 10.84 };
const M_PER_DEG_LAT = 111_132;

function offset(northM: number, eastM: number): { lat: number; lon: number } {
  const mPerDegLon = 111_320 * Math.cos((BASE.lat * Math.PI) / 180);
  return { lat: BASE.lat + northM / M_PER_DEG_LAT, lon: BASE.lon + eastM / mPerDegLon };
}

function wkt(points: { lat: number; lon: number }[]): string {
  return `MULTILINESTRING((${points.map((p) => `${p.lon} ${p.lat}`).join(", ")}))`;
}

/** The nearest way, and a dull one: nothing along it. */
const PLAIN: SeedRoute = {
  osmId: 11,
  route: "hiking",
  name: "Verbindungsweg Beispiel",
  tags: { name: "Verbindungsweg Beispiel", network: "lwn" },
  wkt: wkt([offset(500, 0), offset(500, 4_000)]),
};

/** Three kilometres out, and it goes over a summit. */
const SUMMIT: SeedRoute = {
  osmId: 12,
  route: "hiking",
  name: "Gipfelweg Beispiel",
  tags: { name: "Gipfelweg Beispiel", network: "lwn" },
  wkt: wkt([offset(3_000, 0), offset(3_000, 4_000)]),
};

/**
 * Six kilometres out, nothing along it here, but a European trail
 * with an article — and far beyond the search, a castle it passes
 * that must not count.
 */
const LONG: SeedRoute = {
  osmId: 13,
  route: "hiking",
  name: "Fernwanderweg Beispiel",
  tags: { name: "Fernwanderweg Beispiel", network: "iwn", wikipedia: "de:Fernwanderweg Beispiel" },
  wkt: wkt([offset(6_000, 0), offset(6_000, 4_000), offset(6_000, 150_000)]),
};

const POIS: SeedPoi[] = [
  // Along the summit way.
  { osmId: 101, ...offset(3_050, 1_000), kind: "natural=peak", tags: { name: "Monte Beispiel" } },
  { osmId: 102, ...offset(2_950, 2_000), kind: "tourism=viewpoint", tags: {} },
  { osmId: 103, ...offset(3_020, 3_000), kind: "amenity=restaurant", tags: { name: "Rifugio Beispiel" } },
  // Along it too, and not worth counting: a nameless tower, a wayside
  // cross, a church.
  { osmId: 104, ...offset(3_010, 3_500), kind: "man_made=tower", tags: {} },
  { osmId: 105, ...offset(3_010, 3_600), kind: "historic=wayside_cross", tags: { name: "Kreuz" } },
  { osmId: 106, ...offset(3_010, 3_700), kind: "building=church", tags: { name: "Kirche Beispiel" } },
  // A kilometre off the line: somewhere else, not something passed.
  { osmId: 107, ...offset(4_000, 2_000), kind: "natural=peak", tags: { name: "Nebengipfel" } },
  // Along the long way, but a hundred kilometres from here.
  { osmId: 108, ...offset(6_000, 120_000), kind: "historic=castle", tags: { name: "Burg Fernab" } },
];

let available = false;

before(async () => {
  available = await postgisAvailable();
  if (!available) return;
  await createSeededRegion(DB, POIS);
  await seedRoutes(DB, [PLAIN, SUMMIT, LONG]);
});

after(async () => {
  if (!available) return;
  await dropRegion(DB);
});

test("by default the nearest comes first, as it always did", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const page = await searchRoutes(DB, { center: BASE, radiusM: 10_000 });
  assert.deepEqual(page.routes.map((r) => r.id), [11, 12, 13]);
});

test("ordered by worth, the ways with something along them come first", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const page = await searchRoutes(DB, { center: BASE, radiusM: 10_000, order: "worth" });
  const ids = page.routes.map((r) => r.id);
  assert.equal(ids.at(-1), 11, "the dull near way drops to the end");
  assert.ok(page.routes[0].worth > page.routes.at(-1)!.worth);
});

test("counts what lies along the line, and names it", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const page = await searchRoutes(DB, { center: BASE, radiusM: 10_000 });
  const summit = page.routes.find((r) => r.id === 12)!;
  assert.deepEqual(summit.highlights, [
    { category: "peak", count: 1, names: ["Monte Beispiel"] },
    { category: "viewpoint", count: 1, names: [] },
    { category: "food", count: 1, names: ["Rifugio Beispiel"] },
  ]);
});

test("a thing a kilometre off the path is not passed", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const page = await searchRoutes(DB, { center: BASE, radiusM: 10_000 });
  const summit = page.routes.find((r) => r.id === 12)!;
  const peak = summit.highlights.find((h) => h.category === "peak")!;
  assert.equal(peak.names.includes("Nebengipfel"), false);
});

test("a long way is judged on the stretch near here", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  // It does pass a castle — a hundred kilometres away, which is no
  // reason to walk it from here.
  const page = await searchRoutes(DB, { center: BASE, radiusM: 10_000 });
  const long = page.routes.find((r) => r.id === 13)!;
  assert.deepEqual(long.highlights, []);
  // Its network and article still speak for it.
  assert.equal(long.worth, 5);
  assert.equal(long.wikipedia, "de:Fernwanderweg Beispiel");
});

test("refuses an order it does not know", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  await assert.rejects(
    searchRoutes(DB, { center: BASE, radiusM: 10_000, order: "stars" as never }),
    RouteSearchError,
  );
});

test("folds kinds into categories, capped at three names", () => {
  const highlights = highlightsFrom([
    { kind: "historic=castle", count: 1, names: ["Burg A"] },
    { kind: "building=castle", count: 2, names: ["Burg B", "Burg A", "Burg C"] },
    { kind: "historic=ruins", count: 1, names: null },
    { kind: "historic=wayside_cross", count: 9, names: ["Kreuz"] },
  ]);
  assert.deepEqual(highlights, [
    { category: "castle", count: 3, names: ["Burg A", "Burg B", "Burg C"] },
    { category: "historic", count: 1, names: [] },
  ]);
});

test("a way with nothing known about it is worth nothing, not less", () => {
  assert.equal(highlightsFrom(null).length, 0);
  assert.equal(routeWorth({ network: null, wikipedia: null, wikidata: null, highlights: [] }), 0);
});

test("thirty cafés do not outweigh a summit", () => {
  const cafes = routeWorth({
    network: null, wikipedia: null, wikidata: null,
    highlights: [{ category: "food", count: 30, names: [] }],
  });
  const summit = routeWorth({
    network: null, wikipedia: null, wikidata: null,
    highlights: [{ category: "peak", count: 1, names: [] }],
  });
  assert.ok(summit > cafes);
});

test("ranks networks by how far people travel for them", () => {
  assert.ok(networkRank("iwn") > networkRank("nwn"));
  assert.ok(networkRank("ncn") > networkRank("rcn"));
  assert.ok(networkRank("rwn") > networkRank("lwn"));
  assert.equal(networkRank(null), 0);
  assert.equal(networkRank("something"), 0);
});
