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
import pg from "pg";
import { createSeededRegion, dropRegion, postgisAvailable, type SeedPoi } from "./test-db.ts";
import { readRegionStorage } from "./storage.ts";

const HOST = process.env.GEO_DB_HOST ?? "geo-db";
const PORT = parseInt(process.env.GEO_DB_PORT ?? "5432", 10);
const USER = process.env.GEO_DB_USER ?? "postgres";
const PASSWORD = process.env.GEO_DB_PASSWORD ?? "postgres";
const ADMIN_DB = process.env.GEO_DB_ADMIN_DB ?? "postgres";

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

// A region imported before `shape`/`facade_azimuth` were added to the
// osm2pgsql schema still has an `osm_pois` table without them —
// osm2pgsql only applies the schema on create, it never migrates an
// existing table. This reproduces that pre-existing state directly
// (createSeededRegion always builds the current, wider schema) so the
// read has to survive a region that hasn't been re-imported yet.
const OLD_SCHEMA_DB = "geo_test_storage_old_schema";

test("survives a region imported before shape/facade_azimuth existed", async (t) => {
  if (skipUnlessDb(t)) return;

  await dropRegion(OLD_SCHEMA_DB);
  const admin = new pg.Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: ADMIN_DB });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${OLD_SCHEMA_DB}`);
  } finally {
    await admin.end().catch(() => {});
  }

  const client = new pg.Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: OLD_SCHEMA_DB });
  await client.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS postgis");
    await client.query(`
      CREATE TABLE osm_pois (
        osm_id   bigint,
        osm_type char(1),
        kind     text,
        name     text,
        tags     jsonb,
        geom     geometry(Point, 4326) NOT NULL
      )
    `);
    await client.query(
      `INSERT INTO osm_pois (osm_id, osm_type, kind, name, tags, geom)
       VALUES (1, 'N', 'tourism=museum', 'Altes Museum', '{}'::jsonb,
               ST_SetSRID(ST_Point($1, $2), 4326))`,
      [LON, LAT],
    );
  } finally {
    await client.end().catch(() => {});
  }

  try {
    const storage = await readRegionStorage(OLD_SCHEMA_DB);
    assert.equal(storage.poiTotal, 1);
    assert.equal(storage.poisWithShape, 0);
    assert.equal(storage.poisWithFacadeAzimuth, 0);
  } finally {
    await dropRegion(OLD_SCHEMA_DB);
  }
});
