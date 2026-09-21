/**
 * Full-geometry tests against a real PostGIS database.
 *
 * The one thing this function exists for is the thing a query double
 * could not check: that what comes out is the course as it was
 * imported, and not the map's simplified shape. So the seeded way has
 * more points than `route-search.ts` would ever hand out, and the test
 * counts them.
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
import { routeGeometry } from "./route-geometry.ts";
import { MAX_VIA_POINTS, RouteSearchError, searchRoutes } from "./route-search.ts";

const DB = "geo_test_route_geometry";

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

/**
 * A way that wanders: two hundred points over four kilometres, each a
 * little off the straight line.
 *
 * The wandering is the test. A straight way would survive both
 * simplification and thinning and prove nothing; this one loses most
 * of itself to either, so "the export kept them all" is a claim with
 * something behind it.
 */
const SWITCHBACKS = Array.from({ length: 200 }, (_, i) => {
  const along = (i / 199) * 4_000;
  // A zigzag of about fifteen metres — well inside the fifty-metre
  // tolerance the search simplifies with, so the search drops it.
  return offset(along, i % 2 === 0 ? -15 : 15);
});

const SERPENTINE: SeedRoute = {
  osmId: 1,
  route: "hiking",
  name: "Serpentinenweg Beispiel",
  tags: {
    name: "Serpentinenweg Beispiel",
    network: "lwn",
    ref: "B7",
    ascent: "600 m",
    website: "https://beispiel.test/serpentine",
  },
  wkt: wkt([SWITCHBACKS]),
};

/** Two pieces with a gap between them — a relation with a hole. */
const GAPPED: SeedRoute = {
  osmId: 2,
  route: "foot",
  name: "Lückenweg Beispiel",
  tags: { name: "Lückenweg Beispiel" },
  wkt: wkt([
    [offset(0, 2_000), offset(1_000, 2_000)],
    [offset(3_000, 2_000), offset(4_000, 2_000)],
  ]),
};

let available = false;

before(async () => {
  available = await postgisAvailable();
  if (!available) return;
  await createSeededRegion(DB, []);
  await seedRoutes(DB, [SERPENTINE, GAPPED]);
});

after(async () => {
  if (available) await dropRegion(DB);
});

test("the export keeps every point the map's shape throws away", async (t) => {
  if (!available) return t.skip("no PostGIS available");

  const full = await routeGeometry(DB, 1);
  assert.ok(full);
  assert.equal(full.parts.length, 1);
  assert.equal(full.parts[0].length, SWITCHBACKS.length);

  // And the same way, as the planner sees it: this is what must *not*
  // end up in a file somebody follows.
  const page = await searchRoutes(DB, { center: BASE, radiusM: 10_000 });
  const asPlanned = page.routes.find((r) => r.id === 1);
  assert.ok(asPlanned);
  assert.ok(asPlanned.via.length <= MAX_VIA_POINTS);
  assert.ok(asPlanned.via.length < full.parts[0].length);
});

test("it carries what a file needs to name itself", async (t) => {
  if (!available) return t.skip("no PostGIS available");

  const full = await routeGeometry(DB, 1);
  assert.ok(full);
  assert.equal(full.osmRef, "relation:1");
  assert.equal(full.name, "Serpentinenweg Beispiel");
  assert.equal(full.route, "hiking");
  assert.equal(full.ref, "B7");
  assert.equal(full.network, "lwn");
  assert.equal(full.ascentM, 600);
  assert.equal(full.website, "https://beispiel.test/serpentine");
  // Measured along the way, not across it: the zigzag runs four
  // kilometres north and about seven along the ground, and the longer
  // number is the one somebody walks.
  assert.ok(full.lengthM > 6_000 && full.lengthM < 9_000, `lengthM was ${full.lengthM}`);
  assert.equal(full.joined, true);
});

test("a relation with a gap comes back as its parts, and says so", async (t) => {
  if (!available) return t.skip("no PostGIS available");

  // Not one track drawn straight across the hole: the gap is in the
  // data, and a file that hides it sends somebody across country.
  const full = await routeGeometry(DB, 2);
  assert.ok(full);
  assert.equal(full.joined, false);
  assert.equal(full.parts.length, 2);
  assert.equal(full.parts[0].length, 2);
  assert.equal(full.parts[1].length, 2);
});

test("a relation this region does not have is an answer, not an error", async (t) => {
  if (!available) return t.skip("no PostGIS available");

  assert.equal(await routeGeometry(DB, 999_999), null);
});

test("a region with no routes table answers the same way", async (t) => {
  if (!available) return t.skip("no PostGIS available");

  const old = "geo_test_route_geometry_old";
  await createSeededRegion(old, []);
  try {
    // An import from before §4.7 has no osm_routes at all. For one
    // relation, "we never imported any" and "not here" are the same
    // answer to the caller.
    assert.equal(await routeGeometry(old, 1), null);
  } finally {
    await dropRegion(old);
  }
});

test("a nonsense id is refused rather than sent to the database", async (t) => {
  if (!available) return t.skip("no PostGIS available");

  await assert.rejects(() => routeGeometry(DB, 0), RouteSearchError);
  await assert.rejects(() => routeGeometry(DB, -1), RouteSearchError);
  await assert.rejects(() => routeGeometry(DB, 1.5), RouteSearchError);
});
