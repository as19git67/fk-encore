/**
 * Storage breakdown, against a real PostGIS instance.
 *
 * The point of these numbers is to be measured against each other
 * before and after a re-import, so the test checks the shape and the
 * relationships rather than absolute sizes, which depend on the
 * server's page layout and statistics.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createSeededRegion, dropRegion, postgisAvailable, type SeedPoi } from "./test-db.ts";
import { readRegionStorage } from "./storage.ts";

const DB = "geo_test_storage";
const LAT = 48.37;
const LON = 10.9;

const SEED: SeedPoi[] = [
  {
    osmId: 1,
    lat: LAT,
    lon: LON,
    kind: "tourism=museum",
    tags: { tourism: "museum", name: "Beispielmuseum" },
  },
  {
    osmId: 2,
    lat: LAT + 0.001,
    lon: LON,
    kind: "amenity=cafe",
    tags: { amenity: "cafe", name: "Café eins" },
  },
  {
    osmId: 3,
    lat: LAT + 0.002,
    lon: LON,
    kind: "amenity=cafe",
    tags: { amenity: "cafe", name: "Café zwei" },
  },
  {
    osmId: 4,
    osmType: "W",
    lat: LAT + 0.003,
    lon: LON,
    kind: "building=church",
    tags: { building: "church", name: "Beispielkirche" },
    shapeWkt: `POLYGON((${LON} ${LAT + 0.003}, ${LON + 0.001} ${LAT + 0.003}, ${LON + 0.001} ${LAT + 0.0035}, ${LON} ${LAT + 0.0035}, ${LON} ${LAT + 0.003}))`,
    facadeAzimuth: 0,
  },
];

let available = false;

before(async () => {
  available = await postgisAvailable();
  if (available) await createSeededRegion(DB, SEED);
});

after(async () => {
  if (available) await dropRegion(DB);
});

function skipUnlessDb(t: { skip: (reason?: string) => void }): boolean {
  if (!available) {
    t.skip("no PostGIS-capable server reachable (set GEO_DB_HOST)");
    return true;
  }
  return false;
}

test("reports the database size and the tables it knows about", async (t) => {
  if (skipUnlessDb(t)) return;
  const storage = await readRegionStorage(DB);

  assert.equal(storage.database, DB);
  assert.ok(storage.sizeMb > 0, "a database always occupies something");

  const pois = storage.tables.find((tbl) => tbl.table === "osm_pois");
  assert.ok(pois, "osm_pois must be reported");
  // Total includes indexes and TOAST, so it can never be the smaller of
  // the two — that ordering is the whole reason both are reported.
  assert.ok(pois.totalMb >= pois.tableMb);
});

test("skips tables the region does not have instead of failing", async (t) => {
  if (skipUnlessDb(t)) return;
  const storage = await readRegionStorage(DB);
  // The seeded region has no highways, admin areas or slim middle
  // tables; a half-imported region must still report what it does have.
  assert.deepEqual(storage.tables.map((tbl) => tbl.table), ["osm_pois"]);
});

test("counts POIs per matched tag, biggest first", async (t) => {
  if (skipUnlessDb(t)) return;
  const storage = await readRegionStorage(DB);

  assert.equal(storage.poiTotal, 4);
  assert.deepEqual(storage.poisByKind, [
    { kind: "amenity=cafe", count: 2 },
    { kind: "building=church", count: 1 },
    { kind: "tourism=museum", count: 1 },
  ]);
});

test("reports how many POIs carry an outline and an azimuth", async (t) => {
  if (skipUnlessDb(t)) return;
  const storage = await readRegionStorage(DB);
  assert.equal(storage.poisWithShape, 1);
  assert.equal(storage.poisWithFacadeAzimuth, 1);
});
