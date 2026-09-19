/**
 * Route-search tests against a real PostGIS database.
 *
 * The whole point of keeping a route as geometry rather than as two
 * columns is that the interesting answers are geometric, and each one
 * is easy to get wrong in a way no query double would notice:
 *
 *   - a relation whose members join up has two ends; one with a gap in
 *     it has none that can be stated, and must say so rather than
 *     offer a loose end as the finish;
 *   - a loop finishes where it started, which the plan wants to hear
 *     as "no far end" (§4.7);
 *   - "near here" means the *way* passes near here, not its start.
 *
 * See test-db.ts for why these run against a real database.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  createSeededRegion,
  dropRegion,
  postgisAvailable,
  seedRoutes,
  type SeedRoute,
} from "./test-db.ts";
import {
  MAX_VIA_POINTS,
  RouteSearchError,
  ROUTE_KINDS,
  searchRoutes,
} from "./route-search.ts";

const DB = "geo_test_route_search";
/** A region with no osm_routes table — an import from before §4.7. */
const OLD_DB = "geo_test_route_old";

/** Coordinates sit near Lake Garda; every place is invented. */
const BASE = { lat: 45.88, lon: 10.84 };
const M_PER_DEG_LAT = 111_132;

function offset(northM: number, eastM: number): { lat: number; lon: number } {
  const mPerDegLon = 111_320 * Math.cos((BASE.lat * Math.PI) / 180);
  return { lat: BASE.lat + northM / M_PER_DEG_LAT, lon: BASE.lon + eastM / mPerDegLon };
}

function wkt(parts: { lat: number; lon: number }[][]): string {
  const line = (pts: { lat: number; lon: number }[]) =>
    `(${pts.map((p) => `${p.lon} ${p.lat}`).join(", ")})`;
  return `MULTILINESTRING(${parts.map(line).join(", ")})`;
}

/** A straight way running eight kilometres north from the base point. */
const PANORAMA: SeedRoute = {
  osmId: 1,
  route: "hiking",
  name: "Panoramaweg Beispiel",
  tags: { name: "Panoramaweg Beispiel", network: "lwn", ref: "E1", ascent: "600 m" },
  wkt: wkt([[offset(0, 0), offset(4_000, 0), offset(8_000, 0)]]),
};

/** A loop: out east, back again, finishing beside where it began. */
const LOOP: SeedRoute = {
  osmId: 2,
  route: "bicycle",
  name: "Rundweg Beispiel",
  tags: { name: "Rundweg Beispiel", ascent: "120" },
  wkt: wkt([[offset(0, 0), offset(1_000, 1_000), offset(0, 2_000), offset(-20, 40)]]),
};

/** Two members that do not touch — a relation with a hole in it. */
const GAPPED: SeedRoute = {
  osmId: 3,
  route: "foot",
  name: "Lückenweg Beispiel",
  tags: { name: "Lückenweg Beispiel" },
  wkt: wkt([
    [offset(0, 5_000), offset(1_000, 5_000)],
    [offset(3_000, 5_000), offset(4_000, 5_000)],
  ]),
};

/** Far enough away to sit outside every radius these tests use. */
const FAR: SeedRoute = {
  osmId: 4,
  route: "mtb",
  name: "Fernweg Beispiel",
  tags: { name: "Fernweg Beispiel" },
  wkt: wkt([[offset(40_000, 40_000), offset(41_000, 40_000)]]),
};

let available = false;

before(async () => {
  available = await postgisAvailable();
  if (!available) return;
  await createSeededRegion(DB, []);
  await seedRoutes(DB, [PANORAMA, LOOP, GAPPED, FAR]);
  await createSeededRegion(OLD_DB, []);
});

after(async () => {
  if (!available) return;
  await dropRegion(DB);
  await dropRegion(OLD_DB);
});

test("reads both ends off a way whose members join up", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const page = await searchRoutes(DB, { center: BASE, radiusM: 2_000, kinds: ["hiking"] });
  assert.equal(page.imported, true);
  assert.equal(page.routes.length, 1);

  const route = page.routes[0];
  assert.equal(route.osmRef, "relation:1");
  assert.equal(route.joined, true);
  assert.equal(route.roundtrip, false);
  assert.ok(Math.abs(route.start.lat - BASE.lat) < 1e-6);
  assert.ok(route.end !== null);
  // Eight kilometres north of the start, give or take the projection.
  assert.ok(Math.abs(route.end!.lat - offset(8_000, 0).lat) < 1e-4);
});

test("measures the length of the way, not the line between its ends", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const [route] = (await searchRoutes(DB, { center: BASE, radiusM: 2_000, kinds: ["bicycle"] })).routes;
  // The loop's four legs are far longer than the gap between its ends.
  assert.ok(route.lengthM > 3_000, `expected a real length, got ${route.lengthM}`);
});

test("a loop has no far end to carry the day on from", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const [route] = (await searchRoutes(DB, { center: BASE, radiusM: 2_000, kinds: ["bicycle"] })).routes;
  assert.equal(route.roundtrip, true);
  assert.equal(route.end, null);
  // It still joined up — that is how we know it is a loop and not a
  // relation with a hole in it.
  assert.equal(route.joined, true);
});

test("a relation with a gap states no end rather than a loose one", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const [route] = (await searchRoutes(DB, { center: offset(2_000, 5_000), radiusM: 3_000, kinds: ["foot"] })).routes;
  assert.equal(route.joined, false);
  assert.equal(route.end, null);
  assert.deepEqual(route.via, []);
  // The start is still worth having: it is where the signs begin.
  assert.ok(Number.isFinite(route.start.lat));
});

test("hands back a shape the planner can measure against", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const [route] = (await searchRoutes(DB, { center: BASE, radiusM: 2_000, kinds: ["hiking"] })).routes;
  assert.ok(route.via.length >= 2, "a joined way has a shape");
  assert.ok(route.via.length <= MAX_VIA_POINTS);
  assert.ok(Math.abs(route.via[0].lat - route.start.lat) < 1e-6);
});

test("finds a way that passes nearby, however far off its start is", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  // Beside the middle of the Panoramaweg: eight kilometres from where
  // it begins, two hundred metres from the way itself.
  const page = await searchRoutes(DB, { center: offset(4_000, 200), radiusM: 500 });
  assert.deepEqual(page.routes.map((r) => r.osmRef), ["relation:1"]);
  assert.ok(page.routes[0].distanceM < 400);
});

test("reads the ascent where it is a number of metres, and not otherwise", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const hiking = (await searchRoutes(DB, { center: BASE, radiusM: 2_000, kinds: ["hiking"] })).routes[0];
  const bicycle = (await searchRoutes(DB, { center: BASE, radiusM: 2_000, kinds: ["bicycle"] })).routes[0];
  assert.equal(hiking.ascentM, 600, "600 m parses");
  assert.equal(bicycle.ascentM, 120, "a bare number parses");
  const gapped = (await searchRoutes(DB, { center: offset(2_000, 5_000), radiusM: 3_000, kinds: ["foot"] })).routes[0];
  assert.equal(gapped.ascentM, null, "an absent tag is not guessed at");
});

test("keeps what is far away out of the answer", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const page = await searchRoutes(DB, { center: BASE, radiusM: 10_000 });
  assert.equal(page.routes.some((r) => r.osmRef === "relation:4"), false);
});

test("answers every kind when none is named", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const page = await searchRoutes(DB, { center: BASE, radiusM: 10_000 });
  assert.deepEqual(page.routes.map((r) => r.route).sort(), ["bicycle", "foot", "hiking"]);
  assert.equal(ROUTE_KINDS.length, 4);
});

test("says a region predating the route import has none, rather than failing", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const page = await searchRoutes(OLD_DB, { center: BASE, radiusM: 10_000 });
  assert.equal(page.imported, false);
  assert.deepEqual(page.routes, []);
});

test("refuses arguments it cannot work with", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  await assert.rejects(
    () => searchRoutes(DB, { center: BASE, radiusM: 0 }),
    RouteSearchError,
  );
  await assert.rejects(
    () => searchRoutes(DB, { center: BASE, radiusM: 1_000, kinds: ["road"] }),
    RouteSearchError,
  );
  await assert.rejects(
    () => searchRoutes(DB, { center: { lat: 99, lon: 10 }, radiusM: 1_000 }),
    RouteSearchError,
  );
});
