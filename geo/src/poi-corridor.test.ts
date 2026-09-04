/**
 * Corridor-search tests against a real PostGIS database.
 *
 * The corridor answers "what can we see on the way?" (§4.2) with an
 * ellipse whose foci are the two ends of the journey. Two things about
 * that shape are easy to get wrong and are what these tests pin down:
 *
 *   - the ellipse extends *past* both foci along the line of travel, so
 *     a spot a little beyond the destination is a legitimate stop — and
 *     the index pre-filter must not quietly drop it;
 *   - a detour counts both ways, so a spot 300 m off the route costs
 *     600 m of budget, not 300.
 *
 * See test-db.ts for why these run against a real database rather than
 * query doubles.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createSeededRegion, dropRegion, postgisAvailable, type SeedPoi } from "./test-db.ts";
import {
  MAX_CORRIDOR_LENGTH_M,
  MAX_DETOUR_BUDGET_M,
  PoiSearchError,
  searchPois,
} from "./poi-search.ts";

const DB = "geo_test_poi_corridor";

/** Coordinates sit near Augsburg; every place is invented. */
const FROM = { lat: 48.3, lon: 10.9 };

const M_PER_DEG_LAT = 111_132;

/** Offset from FROM by whole metres, so the fixture reads as geometry. */
function offset(northM: number, eastM: number): { lat: number; lon: number } {
  const lat = FROM.lat + northM / M_PER_DEG_LAT;
  const mPerDegLon = 111_320 * Math.cos((FROM.lat * Math.PI) / 180);
  return { lat, lon: FROM.lon + eastM / mPerDegLon };
}

/** Four kilometres due east — a short transfer between two towns. */
const TO = offset(0, 4_000);

const SEED: SeedPoi[] = [
  {
    // Halfway along the route: no detour at all.
    osmId: 10,
    ...offset(0, 2_000),
    kind: "tourism=museum",
    tags: { tourism: "museum", name: "Museum am Weg" },
  },
  {
    // 500 m off the midpoint — about 123 m of detour, there and back.
    osmId: 11,
    ...offset(500, 2_000),
    kind: "amenity=cafe",
    tags: { amenity: "cafe", name: "Café Beispielhof" },
  },
  {
    // 2 km off the midpoint — about 1.66 km of detour.
    osmId: 12,
    ...offset(2_000, 2_000),
    kind: "tourism=museum",
    tags: { tourism: "museum", name: "Museum im Beispieltal" },
  },
  {
    // 300 m *past* the destination, on the line of travel: 600 m of
    // detour. Outside the segment, inside the ellipse.
    osmId: 13,
    ...offset(0, 4_300),
    kind: "tourism=museum",
    tags: { tourism: "museum", name: "Museum hinter Musterdorf" },
  },
  {
    // 5 km north of the start: a second destination, not a stop.
    osmId: 15,
    ...offset(5_000, 0),
    kind: "tourism=museum",
    tags: { tourism: "museum", name: "Museum am Beispielberg" },
  },
  {
    // Another region entirely.
    osmId: 16,
    lat: 52.52,
    lon: 13.405,
    kind: "tourism=museum",
    tags: { tourism: "museum", name: "Fernes Museum" },
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

function corridor(detourBudgetM: number) {
  return { from: FROM, to: TO, detourBudgetM };
}

test("a tight budget keeps only what is practically on the route", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, { corridor: corridor(300) });
  assert.deepEqual(spots.map((s) => s.id), [10, 11]);
});

test("the ellipse reaches past the destination", async (t) => {
  if (skipUnlessDb(t)) return;
  // Id 13 lies 300 m beyond the end of the journey — off the segment
  // between the foci, but only 600 m of detour. A pre-filter that
  // buffered the segment too tightly would lose it.
  const { spots } = await searchPois(DB, { corridor: corridor(700) });
  assert.deepEqual(spots.map((s) => s.id), [10, 11, 13]);
});

test("a wider budget admits a spot further off the route, still least detour first", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, { corridor: corridor(2_000) });
  assert.deepEqual(spots.map((s) => s.id), [10, 11, 13, 12]);
  for (let i = 1; i < spots.length; i += 1) {
    assert.ok(
      (spots[i].detourM ?? 0) >= (spots[i - 1].detourM ?? 0),
      "detours must not decrease",
    );
  }
});

test("the reported detour counts the way back as well", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, { corridor: corridor(2_000) });
  const byId = new Map(spots.map((s) => [s.id, s]));

  // On the line: nothing extra.
  assert.ok((byId.get(10)?.detourM ?? -1) < 1);
  // 300 m past the end, so 300 m out and 300 m back.
  assert.ok(Math.abs((byId.get(13)?.detourM ?? 0) - 600) < 20);
  // 500 m off the midpoint of a 4 km route: ~123 m, not ~1000 m.
  assert.ok(Math.abs((byId.get(11)?.detourM ?? 0) - 123) < 20);

  // A corridor has no centre, so there is no distance to report.
  assert.equal(byId.get(10)?.distanceM, null);
});

test("a detour of five kilometres is a second destination, not a stop", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, { corridor: corridor(MAX_DETOUR_BUDGET_M) });
  // Id 15 costs ~7.4 km of detour and is in; id 16 is in another region
  // and stays out however generous the budget.
  assert.ok(spots.map((s) => s.id).includes(15));
  assert.ok(!spots.map((s) => s.id).includes(16));
});

test("categories narrow a corridor the same way they narrow a radius", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, {
    corridor: corridor(2_000),
    categories: ["cafe"],
  });
  assert.deepEqual(spots.map((s) => s.id), [11]);
});

test("from equal to to degenerates to a disc of half the budget", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, {
    corridor: { from: FROM, to: FROM, detourBudgetM: 4_400 },
  });
  // Radius 2200 m around the start: id 10 (2 km east) and id 11
  // (~2.06 km away) are in, id 12 (~2.83 km) is out. The detour is
  // twice the distance, because you come back the way you went.
  assert.deepEqual(spots.map((s) => s.id), [10, 11]);
  assert.ok(Math.abs((spots[0].detourM ?? 0) - 4_000) < 20);
});

test("corridor searches page like the others", async (t) => {
  if (skipUnlessDb(t)) return;
  const first = await searchPois(DB, { corridor: corridor(2_000), limit: 2 });
  assert.deepEqual(first.spots.map((s) => s.id), [10, 11]);
  assert.equal(first.hasMore, true);

  const second = await searchPois(DB, { corridor: corridor(2_000), limit: 2, offset: 2 });
  assert.deepEqual(second.spots.map((s) => s.id), [13, 12]);
  assert.equal(second.hasMore, false);
});

test("bad corridors are rejected before touching the database", async () => {
  await assert.rejects(() => searchPois(DB, { corridor: corridor(0) }), PoiSearchError);
  await assert.rejects(
    () => searchPois(DB, { corridor: corridor(MAX_DETOUR_BUDGET_M + 1) }),
    PoiSearchError,
  );
  await assert.rejects(
    () =>
      searchPois(DB, {
        corridor: { from: FROM, to: { lat: 48.3, lon: 180 }, detourBudgetM: 1_000 },
      }),
    PoiSearchError,
    `a journey longer than ${MAX_CORRIDOR_LENGTH_M} m is not a corridor`,
  );
  await assert.rejects(
    () =>
      searchPois(DB, {
        corridor: { from: FROM, to: { lat: 91, lon: 10.9 }, detourBudgetM: 1_000 },
      }),
    PoiSearchError,
  );
  // Exactly one area, not two.
  await assert.rejects(
    () =>
      searchPois(DB, {
        corridor: corridor(1_000),
        center: { ...FROM, radiusM: 500 },
      }),
    PoiSearchError,
  );
});
