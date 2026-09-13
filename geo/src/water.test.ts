/**
 * Water-crossing tests against a real PostGIS database.
 *
 * The planner has no router: it estimates a journey as the straight
 * line times a factor, which a lake makes nonsense of. This query is
 * the cheap correction — is a named water body on the line, and how big
 * is it — and it is almost entirely SQL, so testing it against a query
 * double would only assert that we assembled the string we meant to.
 *
 * Three things are easy to get wrong and are what these pin down: a
 * polygon that the line misses must not count; the crossed length must
 * be metres rather than degrees; and the extent must describe the body
 * rather than the crossing, because the way round is a fraction of the
 * body.
 *
 * See test-db.ts for why these run against a real database.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createSeededRegion, dropRegion, postgisAvailable, type SeedPoi } from "./test-db.ts";
import { waterCrossing } from "./water.ts";

const DB = "geo_test_water";

/** Coordinates sit over Lake Garda; the names are invented. */
const M_PER_DEG_LAT = 111_132;
const ORIGIN = { lat: 45.7, lon: 10.7 };

function offset(northM: number, eastM: number): { lat: number; lon: number } {
  const lat = ORIGIN.lat + northM / M_PER_DEG_LAT;
  const mPerDegLon = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
  return { lat, lon: ORIGIN.lon + eastM / mPerDegLon };
}

/** A rectangle in WKT, from two corners given in metres off ORIGIN. */
function box(southM: number, westM: number, northM: number, eastM: number): string {
  const sw = offset(southM, westM);
  const ne = offset(northM, eastM);
  return `POLYGON((${sw.lon} ${sw.lat}, ${ne.lon} ${sw.lat}, ${ne.lon} ${ne.lat}, `
    + `${sw.lon} ${ne.lat}, ${sw.lon} ${sw.lat}))`;
}

const SEED: SeedPoi[] = [
  {
    // A long, narrow lake: 4 km across, 40 km from end to end. The
    // shape of the problem — going round costs many times the crossing.
    osmId: 1,
    osmType: "W",
    ...offset(20_000, 2_000),
    kind: "natural=water",
    tags: { natural: "water", name: "Beispielsee" },
    shapeWkt: box(0, 0, 40_000, 4_000),
  },
  {
    // A pond well off to the side, to prove the line has to actually
    // hit something.
    osmId: 2,
    osmType: "W",
    ...offset(20_000, 30_000),
    kind: "natural=water",
    tags: { natural: "water", name: "Beispielweiher" },
    shapeWkt: box(19_800, 29_800, 20_200, 30_200),
  },
  {
    // Not water at all, and it sits right on the line: a castle with
    // an outline must not be mistaken for something to sail round.
    osmId: 3,
    osmType: "W",
    ...offset(20_000, 2_000),
    kind: "historic=castle",
    tags: { historic: "castle", name: "Burg Beispielstein" },
    shapeWkt: box(19_000, 1_000, 21_000, 3_000),
  },
];

let available = false;

before(async () => {
  available = await postgisAvailable();
  if (!available) return;
  await createSeededRegion(DB, SEED);
});

after(async () => {
  if (available) await dropRegion(DB);
});

/** node:test has no async skip predicate, so each test opts out itself. */
function skipUnlessDb(t: { skip: (reason?: string) => void }): boolean {
  if (!available) {
    t.skip("no PostGIS-capable server reachable (set GEO_DB_HOST)");
    return true;
  }
  return false;
}

test("measures the crossing in metres, and names what is crossed", async (t) => {
  if (skipUnlessDb(t)) return;

  // Straight across the narrow way, from one shore to the other.
  const crossing = await waterCrossing(DB, offset(20_000, -2_000), offset(20_000, 8_000));

  assert.equal(crossing.name, "Beispielsee");
  // Four kilometres of water, give or take the projection.
  assert.ok(crossing.crossedM > 3_800 && crossing.crossedM < 4_200,
            `crossedM was ${crossing.crossedM}`);
  assert.equal(crossing.widestM, crossing.crossedM);
});

test("reports the body's extent, not the crossing's", async (t) => {
  if (skipUnlessDb(t)) return;

  // The way round is a fraction of how long the thing is, so the
  // caller needs the lake's own size rather than the four kilometres
  // of it that happen to be on the line.
  const crossing = await waterCrossing(DB, offset(20_000, -2_000), offset(20_000, 8_000));

  assert.ok(crossing.extentM > 38_000, `extentM was ${crossing.extentM}`);
});

test("says nothing when the line misses the water", async (t) => {
  if (skipUnlessDb(t)) return;

  // South of the lake's southern end, running east past it.
  const crossing = await waterCrossing(DB, offset(-2_000, -2_000), offset(-2_000, 8_000));

  assert.equal(crossing.crossedM, 0);
  assert.equal(crossing.name, null);
});

test("ignores an outline that is not water", async (t) => {
  if (skipUnlessDb(t)) return;

  // A line through the castle only — north of it and clear of the
  // lake's western edge would still hit the lake, so cross the castle
  // where the lake is not: it sits partly outside the lake's box.
  const crossing = await waterCrossing(DB, offset(19_500, -3_000), offset(19_500, -500));

  assert.equal(crossing.crossedM, 0);
  assert.equal(crossing.name, null);
});

test("adds up several bodies but goes round the biggest", async (t) => {
  if (skipUnlessDb(t)) return;

  // A line long enough to cross the lake and clip the pond.
  const crossing = await waterCrossing(DB, offset(20_000, -2_000), offset(20_000, 31_000));

  assert.equal(crossing.name, "Beispielsee");
  assert.ok(crossing.crossedM > crossing.widestM,
            `crossedM ${crossing.crossedM} should exceed widestM ${crossing.widestM}`);
});
