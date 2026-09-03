/**
 * Facade azimuth, against a real PostGIS instance.
 *
 * The whole value of this number is that it is geometrically true, so
 * doubles would prove nothing: these seed rectangles with a known
 * orientation and check the angle that comes back.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createSeededRegion, dropRegion, postgisAvailable, type SeedPoi } from "./test-db.ts";
import { refreshFacadeAzimuth } from "./facade-azimuth.ts";
import { poolFor } from "./db.ts";

const DB = "geo_test_facade_azimuth";
const LAT = 48.37;
const LON = 10.9;

/** A rectangle `wide` × `tall` degrees, rotated by `deg` about its centre. */
function rectangle(wide: number, tall: number, deg: number): string {
  const rad = (deg * Math.PI) / 180;
  const corners: [number, number][] = [
    [-wide / 2, -tall / 2],
    [wide / 2, -tall / 2],
    [wide / 2, tall / 2],
    [-wide / 2, tall / 2],
  ];
  const points = corners
    .map(([x, y]) => {
      const rx = x * Math.cos(rad) - y * Math.sin(rad);
      const ry = x * Math.sin(rad) + y * Math.cos(rad);
      return `${LON + rx} ${LAT + ry}`;
    })
    .join(", ");
  const first = points.split(", ")[0];
  return `POLYGON((${points}, ${first}))`;
}

const SEED: SeedPoi[] = [
  {
    // Long side running east-west → the facade faces north/south → 0°.
    osmId: 1,
    osmType: "W",
    lat: LAT,
    lon: LON,
    kind: "building=church",
    tags: { building: "church", name: "Breite Beispielhalle" },
    shapeWkt: rectangle(0.004, 0.001, 0),
  },
  {
    // Long side running north-south → the facade faces east/west → 90°.
    osmId: 2,
    osmType: "W",
    lat: LAT,
    lon: LON + 0.02,
    kind: "building=church",
    tags: { building: "church", name: "Schmale Beispielhalle" },
    shapeWkt: rectangle(0.001, 0.004, 0),
  },
  {
    // A node POI has no outline and must stay null rather than getting
    // an invented orientation.
    osmId: 3,
    lat: LAT,
    lon: LON + 0.04,
    kind: "tourism=viewpoint",
    tags: { tourism: "viewpoint", name: "Aussicht ohne Grundriss" },
  },
  {
    // Already computed: the pass must leave it alone.
    osmId: 4,
    osmType: "W",
    lat: LAT,
    lon: LON + 0.06,
    kind: "building=palace",
    tags: { building: "palace", name: "Vorberechnetes Beispiel" },
    shapeWkt: rectangle(0.004, 0.001, 0),
    facadeAzimuth: 42,
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

async function azimuthOf(osmId: number): Promise<number | null> {
  const res = await poolFor(DB).query<{ facade_azimuth: number | null }>(
    "SELECT facade_azimuth FROM osm_pois WHERE osm_id = $1",
    [osmId],
  );
  const value = res.rows[0]?.facade_azimuth;
  return value === null || value === undefined ? null : Number(value);
}

test("derives the facade normal from the outline", async (t) => {
  if (skipUnlessDb(t)) return;

  const updated = await refreshFacadeAzimuth(DB);
  // Two outlines without an azimuth; the pre-computed one is untouched.
  assert.equal(updated, 2);

  // A hall wider than it is tall faces north/south.
  const wide = await azimuthOf(1);
  assert.ok(wide !== null && Math.abs(wide) < 1, `expected ~0°, got ${wide}`);

  // A hall taller than it is wide faces east/west.
  const tall = await azimuthOf(2);
  assert.ok(tall !== null && Math.abs(tall - 90) < 1, `expected ~90°, got ${tall}`);
});

test("leaves a POI without an outline alone", async (t) => {
  if (skipUnlessDb(t)) return;
  await refreshFacadeAzimuth(DB);
  assert.equal(await azimuthOf(3), null);
});

test("does not recompute what already has a value", async (t) => {
  if (skipUnlessDb(t)) return;
  await refreshFacadeAzimuth(DB);
  assert.equal(await azimuthOf(4), 42);
});

test("is idempotent — a second pass has nothing left to do", async (t) => {
  if (skipUnlessDb(t)) return;
  await refreshFacadeAzimuth(DB);
  assert.equal(await refreshFacadeAzimuth(DB), 0);
});
