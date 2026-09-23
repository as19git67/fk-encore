/**
 * What to look at along one way (§4.7), against a real PostGIS
 * database: which things beside it lead to a picture, and where along
 * it a photo search should look.
 *
 * Coordinates sit near Lake Garda; every place is invented, and so is
 * every Wikidata id.
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
import { RouteSearchError } from "./route-search.ts";
import { ALONG_SAMPLES, evenlySpaced, pointsOf, routeAlong } from "./route-along.ts";

const DB = "geo_test_route_along";
const OLD_DB = "geo_test_route_along_old";
const BASE = { lat: 45.88, lon: 10.84 };

function offset(northM: number, eastM: number): { lat: number; lon: number } {
  const mPerDegLon = 111_320 * Math.cos((BASE.lat * Math.PI) / 180);
  return { lat: BASE.lat + northM / 111_132, lon: BASE.lon + eastM / mPerDegLon };
}

/** Eight kilometres east, then on for a hundred and fifty. */
const WAY: SeedRoute = {
  osmId: 21,
  route: "hiking",
  name: "Gipfelweg Beispiel",
  wkt: `MULTILINESTRING((${[offset(0, 0), offset(0, 2_000), offset(0, 4_000),
    offset(0, 6_000), offset(0, 8_000), offset(0, 150_000)]
    .map((p) => `${p.lon} ${p.lat}`).join(", ")}))`,
};

const POIS: SeedPoi[] = [
  { osmId: 201, ...offset(40, 2_000), kind: "natural=peak",
    tags: { name: "Monte Beispiel", wikidata: "Q9000001" } },
  // The same summit's outline, same item: one picture, not two.
  { osmId: 202, osmType: "W", ...offset(60, 2_010), kind: "natural=peak",
    tags: { name: "Monte Beispiel", wikidata: "Q9000001" } },
  { osmId: 203, ...offset(-30, 5_000), kind: "amenity=cafe",
    tags: { name: "Café Beispiel", wikidata: "Q9000002" } },
  // Beside the way, but no item to find a picture through.
  { osmId: 204, ...offset(20, 3_000), kind: "historic=castle", tags: { name: "Burg ohne Eintrag" } },
  // An item, but a kind nobody walks past on purpose.
  { osmId: 205, ...offset(20, 3_500), kind: "building=church",
    tags: { name: "Kirche Beispiel", wikidata: "Q9000003" } },
  // An item a kilometre off the way.
  { osmId: 206, ...offset(1_000, 4_000), kind: "historic=castle",
    tags: { name: "Burg abseits", wikidata: "Q9000004" } },
  // On the way, a hundred kilometres from here.
  { osmId: 207, ...offset(10, 120_000), kind: "historic=castle",
    tags: { name: "Burg Fernab", wikidata: "Q9000005" } },
  // Not an item at all, whatever the tag says.
  { osmId: 208, ...offset(10, 6_000), kind: "tourism=viewpoint", tags: { wikidata: "kein" } },
];

let available = false;

before(async () => {
  available = await postgisAvailable();
  if (!available) return;
  await createSeededRegion(DB, POIS);
  await seedRoutes(DB, [WAY]);
  await createSeededRegion(OLD_DB, []);
});

after(async () => {
  if (!available) return;
  await dropRegion(DB);
  await dropRegion(OLD_DB);
});

test("names the items beside the way, summit before café, each once", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const along = await routeAlong(DB, 21, { center: BASE, radiusM: 10_000 });
  assert.ok(along);
  assert.deepEqual(along.subjects.map((s) => [s.category, s.wikidata]), [
    ["peak", "Q9000001"],
    ["food", "Q9000002"],
  ]);
});

test("spreads its search points over the stretch near here only", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const along = await routeAlong(DB, 21, { center: BASE, radiusM: 10_000 });
  assert.ok(along);
  assert.ok(along.samples.length >= 2 && along.samples.length <= ALONG_SAMPLES);
  // Nothing from the far end, a hundred and forty kilometres on.
  const farthestEast = Math.max(...along.samples.map((p) => p.lon));
  assert.ok(farthestEast <= offset(0, 10_500).lon, `sample too far east: ${farthestEast}`);
});

test("says so when the region no longer has the way", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  assert.equal(await routeAlong(DB, 99, { center: BASE, radiusM: 10_000 }), null);
  assert.equal(await routeAlong(OLD_DB, 21, { center: BASE, radiusM: 10_000 }), null);
});

test("refuses an id that is not one", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  await assert.rejects(routeAlong(DB, 0, { center: BASE, radiusM: 10_000 }), RouteSearchError);
});

test("reads lines out of whatever shape a clip returns", () => {
  assert.equal(pointsOf(null).length, 0);
  assert.equal(pointsOf("not json").length, 0);
  assert.deepEqual(
    pointsOf(JSON.stringify({ type: "LineString", coordinates: [[10, 45], [11, 46]] })),
    [{ lat: 45, lon: 10 }, { lat: 46, lon: 11 }],
  );
  assert.equal(pointsOf(JSON.stringify({
    type: "GeometryCollection",
    geometries: [
      { type: "Point", coordinates: [9, 44] },
      { type: "MultiLineString", coordinates: [[[10, 45], [11, 46]], [[12, 47], [13, 48]]] },
    ],
  })).length, 4);
});

test("keeps both ends when it thins", () => {
  const points = Array.from({ length: 20 }, (_, i) => ({ lat: i, lon: 0 }));
  const thinned = evenlySpaced(points, 6);
  assert.equal(thinned.length, 6);
  assert.equal(thinned[0].lat, 0);
  assert.equal(thinned[5].lat, 19);
  assert.equal(evenlySpaced(points.slice(0, 3), 6).length, 3);
});
