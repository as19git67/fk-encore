/**
 * Area-search tests against a real PostGIS database.
 *
 * See test-db.ts for why these do not use query doubles.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createSeededRegion, dropRegion, postgisAvailable, type SeedPoi } from "./test-db.ts";
import {
  MAX_BBOX_SPAN_DEG,
  MAX_LIMIT,
  MAX_RADIUS_M,
  PoiSearchError,
  searchPois,
} from "./poi-search.ts";

const DB = "geo_test_poi_search";

/**
 * A compact synthetic city. Coordinates sit near Augsburg but the
 * places are invented — no real addresses or businesses in fixtures.
 */
const CENTRE = { lat: 48.3705, lon: 10.8978 };

function at(dLat: number, dLon: number): { lat: number; lon: number } {
  return { lat: CENTRE.lat + dLat, lon: CENTRE.lon + dLon };
}

const SEED: SeedPoi[] = [
  {
    osmId: 1,
    ...at(0, 0),
    kind: "tourism=museum",
    tags: {
      tourism: "museum",
      name: "Stadtmuseum Beispielstadt",
      "name:en": "Example City Museum",
      wikidata: "Q1",
      wikipedia: "de:Stadtmuseum",
      opening_hours: "Tu-Su 10:00-17:00",
      wheelchair: "yes",
    },
  },
  {
    osmId: 2,
    ...at(0.001, 0),
    kind: "tourism=viewpoint",
    tags: { tourism: "viewpoint", name: "Aussicht am Beispielberg" },
  },
  {
    osmId: 3,
    ...at(0.002, 0),
    kind: "historic=monument",
    tags: { historic: "monument", name: "Denkmal am Musterplatz", wikidata: "Q3" },
    osmType: "W",
  },
  {
    osmId: 4,
    ...at(0.003, 0),
    kind: "amenity=place_of_worship",
    tags: { amenity: "place_of_worship", name: "Beispielkirche" },
    // A pre-computed azimuth, as an import would have left behind.
    facadeAzimuth: 90,
  },
  {
    osmId: 5,
    ...at(0.004, 0),
    kind: "tourism=gallery",
    // Deliberately unnamed: the prominence proxy must still order it last.
    tags: { tourism: "gallery" },
  },
  {
    osmId: 7,
    ...at(0.0005, 0.001),
    kind: "amenity=cafe",
    tags: { amenity: "cafe", name: "Café am Beispielplatz", outdoor_seating: "yes" },
  },
  {
    // Far away — inside no test bbox and outside every test radius.
    osmId: 6,
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

test("radius search returns only spots inside the disc, nearest first", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, {
    center: { ...CENTRE, radiusM: 500 },
  });
  const ids = spots.map((s) => s.id);
  // 0.004° of latitude is ~445 m, so everything but the distant id 6 is
  // inside. The café (7) sits ~93 m out, between ids 1 and 2.
  assert.deepEqual(ids, [1, 7, 2, 3, 4, 5]);
  assert.ok(spots[0].distanceM !== null && spots[0].distanceM < 1);
  for (let i = 1; i < spots.length; i += 1) {
    assert.ok(
      (spots[i].distanceM ?? 0) >= (spots[i - 1].distanceM ?? 0),
      "distances must not decrease",
    );
  }
});

test("a tight radius excludes what lies just outside it", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, { center: { ...CENTRE, radiusM: 150 } });
  // ~111 m per 0.001° of latitude: ids 1, 7 and 2 are in, 3 (~222 m) is out.
  assert.deepEqual(spots.map((s) => s.id), [1, 7, 2]);
});

test("bbox search returns what the rectangle covers, without distances", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, {
    bbox: { minLat: CENTRE.lat - 0.01, minLon: CENTRE.lon - 0.01, maxLat: CENTRE.lat + 0.01, maxLon: CENTRE.lon + 0.01 },
  });
  assert.deepEqual(spots.map((s) => s.id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 7]);
  assert.ok(spots.every((s) => s.distanceM === null));
});

test("without a centre, the prominence proxy orders the first page", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, {
    bbox: { minLat: CENTRE.lat - 0.01, minLon: CENTRE.lon - 0.01, maxLat: CENTRE.lat + 0.01, maxLon: CENTRE.lon + 0.01 },
  });
  // Wikidata + Wikipedia + name beats Wikidata + name beats name alone,
  // and the unnamed gallery comes last.
  assert.equal(spots[0].id, 1);
  assert.equal(spots[1].id, 3);
  assert.equal(spots.at(-1)?.id, 5);
});

test("categories narrow the result and are reported per spot", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, {
    center: { ...CENTRE, radiusM: 1000 },
    categories: ["museum"],
  });
  assert.deepEqual(spots.map((s) => s.id), [1, 5]);
  assert.deepEqual(spots[0].categories, ["museum"]);
});

test("a historic way matches the sight category and keeps its osm type", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, {
    center: { ...CENTRE, radiusM: 1000 },
    categories: ["sight"],
  });
  assert.deepEqual(spots.map((s) => s.id), [3]);
  assert.equal(spots[0].type, "way");
  assert.equal(spots[0].osmRef, "way:3");
});

test("paging is stable and reports whether more remain", async (t) => {
  if (skipUnlessDb(t)) return;
  const area = { center: { ...CENTRE, radiusM: 1000 } } as const;
  const first = await searchPois(DB, { ...area, limit: 2, offset: 0 });
  const second = await searchPois(DB, { ...area, limit: 2, offset: 2 });
  const third = await searchPois(DB, { ...area, limit: 2, offset: 4 });

  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, true);
  assert.equal(third.hasMore, false);
  const seen = [...first.spots, ...second.spots, ...third.spots].map((s) => s.id);
  assert.deepEqual(seen, [1, 7, 2, 3, 4, 5], "pages must not repeat or skip rows");
});

test("limit is capped rather than honoured blindly", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, {
    center: { ...CENTRE, radiusM: 1000 },
    limit: MAX_LIMIT + 5_000,
  });
  assert.ok(spots.length <= MAX_LIMIT);
});

test("names and planning attributes come back when tagged", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, { center: { ...CENTRE, radiusM: 50 } });
  assert.equal(spots[0].name, "Stadtmuseum Beispielstadt");
  assert.equal(spots[0].nameEn, "Example City Museum");
  // Absent tags must come back as null rather than undefined, so a
  // caller can tell "OSM does not say" from "field missing".
  assert.equal(spots[0].nameDe, null);
  assert.equal(spots[0].openingHours, "Tu-Su 10:00-17:00");
  assert.equal(spots[0].wheelchair, "yes");
  assert.equal(spots[0].cuisine, null);
  assert.equal(spots[0].facadeAzimuth, null);
});

test("a café is found by its category but never ranked by quality", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, {
    center: { ...CENTRE, radiusM: 1000 },
    categories: ["cafe"],
  });
  assert.deepEqual(spots.map((s) => s.id), [7]);
  assert.equal(spots[0].outdoorSeating, "yes");
  assert.deepEqual(spots[0].categories, ["cafe"]);
});

test("the facade azimuth is returned where the outline provided one", async (t) => {
  if (skipUnlessDb(t)) return;
  const { spots } = await searchPois(DB, {
    center: { ...CENTRE, radiusM: 1000 },
    categories: ["worship"],
  });
  assert.equal(spots[0].facadeAzimuth, 90);
});

test("bad arguments are rejected before touching the database", async () => {
  await assert.rejects(() => searchPois(DB, {}), PoiSearchError);
  await assert.rejects(
    () => searchPois(DB, { bbox: { minLat: 1, minLon: 1, maxLat: 0, maxLon: 2 } }),
    PoiSearchError,
  );
  await assert.rejects(
    () =>
      searchPois(DB, {
        bbox: { minLat: 0, minLon: 0, maxLat: MAX_BBOX_SPAN_DEG + 1, maxLon: 1 },
      }),
    PoiSearchError,
  );
  await assert.rejects(
    () => searchPois(DB, { center: { ...CENTRE, radiusM: MAX_RADIUS_M + 1 } }),
    PoiSearchError,
  );
  await assert.rejects(
    () => searchPois(DB, { center: { ...CENTRE, radiusM: 100 }, categories: ["restaurant"] }),
    PoiSearchError,
  );
  await assert.rejects(
    () =>
      searchPois(DB, {
        center: { ...CENTRE, radiusM: 100 },
        bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
      }),
    PoiSearchError,
  );
});
