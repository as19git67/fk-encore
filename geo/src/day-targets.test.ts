/**
 * Day-target tests against a real PostGIS database (§4.6).
 *
 * What this search claims is arithmetic over geometry — which spots
 * lie in the ring, which named area holds each of them, and what is
 * left over — and every one of those is easy to get wrong in a way a
 * query double would happily confirm:
 *
 *   - a spot inside the leg's own radius is already in its pool, and
 *     counting it would propose a day trip to where you are;
 *   - the most local named area is the destination, not the province
 *     it sits in;
 *   - a place that is no municipality at all still has to be findable,
 *     or the valley with the three monasteries never gets suggested.
 *
 * See test-db.ts for why these run against a real database. Every
 * place is invented; the coordinates sit near Lake Garda.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  createSeededRegion,
  dropRegion,
  postgisAvailable,
  seedAdmin,
  type SeedAdminArea,
  type SeedPoi,
} from "./test-db.ts";
import { DayTargetError, searchDayTargets } from "./day-targets.ts";

const DB = "geo_test_day_targets";

const BASE = { lat: 45.88, lon: 10.84 };
const M_PER_DEG_LAT = 111_132;
const M_PER_DEG_LON = 111_320 * Math.cos((BASE.lat * Math.PI) / 180);

function offset(northM: number, eastM: number): { lat: number; lon: number } {
  return { lat: BASE.lat + northM / M_PER_DEG_LAT, lon: BASE.lon + eastM / M_PER_DEG_LON };
}

/** A square of the given half-width in metres, centred on a point. */
function square(centre: { lat: number; lon: number }, halfM: number): string {
  const dLat = halfM / M_PER_DEG_LAT;
  const dLon = halfM / M_PER_DEG_LON;
  const corners = [
    [centre.lon - dLon, centre.lat - dLat],
    [centre.lon + dLon, centre.lat - dLat],
    [centre.lon + dLon, centre.lat + dLat],
    [centre.lon - dLon, centre.lat + dLat],
    [centre.lon - dLon, centre.lat - dLat],
  ];
  return `POLYGON((${corners.map(([lon, lat]) => `${lon} ${lat}`).join(", ")}))`;
}

let osmId = 0;

/** A spot worth a block: named, and linked or tagged as a sight. */
function sight(
  at: { lat: number; lon: number },
  name: string,
  opts: { linked?: boolean; kind?: string } = {},
): SeedPoi {
  osmId += 1;
  const tags: Record<string, string> = { name };
  if (opts.linked !== false) tags.wikidata = `Q${osmId}`;
  return { osmId, lat: at.lat, lon: at.lon, kind: opts.kind ?? "tourism=attraction", tags };
}

/** Somewhere that merely exists: a name and nothing else. */
function ordinary(at: { lat: number; lon: number }, name: string): SeedPoi {
  osmId += 1;
  return { osmId, lat: at.lat, lon: at.lon, kind: "amenity=bank", tags: { name } };
}

/** The big town 25 km north, where a day would actually go. */
const TOWN = offset(25_000, 0);
/** A hamlet 20 km east with one thing in it. */
const HAMLET = offset(0, 20_000);
/** A valley 40 km north-east that is no municipality of its own. */
const VALLEY = offset(30_000, 25_000);

const POIS: SeedPoi[] = [
  // Five in the town, four of them linked.
  sight(offset(25_000, 0), "Stadtmuseum Beispiel"),
  sight(offset(25_400, 300), "Burgruine Beispiel"),
  sight(offset(24_600, -200), "Dom zu Beispielstadt"),
  sight(offset(25_100, 600), "Galerie am Markt"),
  sight(offset(24_900, 100), "Aussichtsturm Beispiel", { linked: false, kind: "tourism=viewpoint" }),
  // Plus something ordinary, which must not count towards a day.
  ordinary(offset(25_200, 200), "Sparkasse Beispielstadt"),

  // One in the hamlet.
  sight(HAMLET, "Wallfahrtskapelle Beispiel"),

  // Three in the valley, in no named area.
  sight(offset(30_000, 25_000), "Kloster im Beispieltal"),
  sight(offset(30_300, 25_400), "Wasserfall Beispiel"),
  sight(offset(29_700, 24_600), "Schlucht Beispiel"),

  // Two on the doorstep: inside the leg's own radius, already in the pool.
  sight(offset(2_000, 0), "Pfarrkirche am Ort"),
  sight(offset(1_500, 500), "Heimatmuseum am Ort"),
];

const AREAS: SeedAdminArea[] = [
  { osmId: 900, name: "Beispielstadt", adminLevel: 8, wkt: square(TOWN, 4_000) },
  { osmId: 901, name: "Kleinsthausen", adminLevel: 8, wkt: square(HAMLET, 2_000) },
  // The province holds all of it and must never name a destination.
  { osmId: 902, name: "Provinz Beispiel", adminLevel: 6, wkt: square(BASE, 60_000) },
];

let available = false;

before(async () => {
  available = await postgisAvailable();
  if (!available) return;
  await createSeededRegion(DB, POIS);
  await seedAdmin(DB, AREAS);
});

after(async () => {
  if (available) await dropRegion(DB);
});

const RING = { center: BASE, minRadiusM: 5_000, maxRadiusM: 60_000 };

test("names the town that would carry a day, and counts what is in it", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const { targets } = await searchDayTargets(DB, RING);

  const town = targets.find((target) => target.name === "Beispielstadt");
  assert.ok(town, "the town should be among the targets");
  // Five sights, not six: the savings bank has a name and nothing else.
  assert.equal(town.spotCount, 5);
  assert.equal(town.linkedCount, 4);
  assert.equal(town.source, "admin");
  assert.equal(town.osmRef, "area:900");
  assert.equal(town.adminLevel, 8);
});

test("puts the strongest destination first", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const { targets } = await searchDayTargets(DB, RING);
  assert.equal(targets[0].name, "Beispielstadt");
});

test("finds the valley that is no municipality, through the grid", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const { targets } = await searchDayTargets(DB, RING);

  const valley = targets.find((target) => target.source === "cluster");
  assert.ok(valley, "the spots in no named area should still be findable");
  assert.equal(valley.spotCount, 3);
  assert.equal(valley.osmRef, null);
  assert.equal(valley.adminLevel, null);
  // Named after what is there, since no boundary names it.
  assert.ok(
    ["Kloster im Beispieltal", "Wasserfall Beispiel", "Schlucht Beispiel"].includes(valley.name),
    `unexpected cluster name: ${valley.name}`,
  );
});

test("never names the province, though it contains everything", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  // A day out to "Provinz Beispiel" is not a destination, and a level
  // that holds every spot would drown every real one.
  const { targets } = await searchDayTargets(DB, RING);
  assert.equal(targets.find((target) => target.name === "Provinz Beispiel"), undefined);
});

test("counts a spot once, in the most local place that holds it", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const { targets } = await searchDayTargets(DB, RING);
  const total = targets.reduce((sum, target) => sum + target.spotCount, 0);
  // Nine in the ring: five in town, one in the hamlet, three in the
  // valley. Two more sit inside the inner radius and belong to the
  // leg's own pool.
  assert.equal(total, 9);
});

test("leaves out what is already on the doorstep", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const { targets } = await searchDayTargets(DB, RING);
  const named = targets.flatMap((target) => target.examples);
  assert.equal(named.includes("Pfarrkirche am Ort"), false);
  assert.equal(named.includes("Heimatmuseum am Ort"), false);
});

test("answers where the spots are, not where the boundary's middle is", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const { targets } = await searchDayTargets(DB, RING);
  const town = targets.find((target) => target.name === "Beispielstadt");
  assert.ok(town);
  // The five sights cluster within a few hundred metres of each other.
  assert.ok(Math.abs(town.at.lat - TOWN.lat) < 0.01, `lat was ${town.at.lat}`);
  assert.ok(Math.abs(town.distanceM - 25_000) < 1_000, `distance was ${town.distanceM}`);
});

test("says what is there by name, so a suggestion can argue for itself", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const { targets } = await searchDayTargets(DB, RING);
  const town = targets.find((target) => target.name === "Beispielstadt");
  assert.ok(town);
  assert.ok(town.examples.length > 0 && town.examples.length <= 3);
  // The unlinked viewpoint is the weakest of the five and comes last.
  assert.equal(town.examples.includes("Aussichtsturm Beispiel"), false);
});

test("keeps the hamlet in, and lets the planner decide it is too little", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  // Counting is this module's job; "is one sight worth an hour in the
  // car" is the trip's (§4.6).
  const { targets } = await searchDayTargets(DB, RING);
  const hamlet = targets.find((target) => target.name === "Kleinsthausen");
  assert.ok(hamlet);
  assert.equal(hamlet.spotCount, 1);
});

test("stops at the far edge of the ring", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const { targets } = await searchDayTargets(DB, {
    center: BASE,
    minRadiusM: 5_000,
    maxRadiusM: 22_000,
  });
  const names = targets.map((target) => target.name);
  assert.equal(names.includes("Kleinsthausen"), true);
  assert.equal(names.includes("Beispielstadt"), false);
});

test("says when there is more than it handed back", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const page = await searchDayTargets(DB, { ...RING, limit: 1 });
  assert.equal(page.targets.length, 1);
  assert.equal(page.hasMore, true);
});

test("refuses a ring that is not one", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  await assert.rejects(
    () => searchDayTargets(DB, { center: BASE, minRadiusM: 50_000, maxRadiusM: 20_000 }),
    DayTargetError,
  );
  await assert.rejects(
    () => searchDayTargets(DB, { center: { lat: 91, lon: 0 }, minRadiusM: 5_000, maxRadiusM: 20_000 }),
    DayTargetError,
  );
});
