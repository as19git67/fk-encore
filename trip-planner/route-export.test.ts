/**
 * Handing a route over as GPX (§4.7).
 *
 * Two things carry the risk and both are tested: that the export goes
 * through the *plan* rather than letting anybody name a region and a
 * relation id, and that every "no" a traveller can hit comes back as a
 * status with a sentence rather than as a five-hundred.
 *
 * That the exported course is finer than the map's shape is a fact
 * about PostGIS and is tested there (`geo/src/route-geometry.test.ts`).
 *
 * Coordinates sit near Lake Garda; every place is invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoRoute } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan } from "./plans";
import { relationId, routeGpx } from "./route-export";

vi.mock("~encore/auth", () => ({ getAuthData: vi.fn() }));

const ANCHOR = { lat: 45.88, lon: 10.84 };
const TIME = new Date("2026-05-01T08:00:00.000Z");

function route(overrides: Partial<GeoRoute> & { osmRef: string; id: number }): GeoRoute {
  return {
    name: "Panoramaweg Beispiel",
    route: "hiking",
    network: "lwn",
    ref: "B7",
    lengthM: 10_000,
    ascentM: 600,
    distanceM: 500,
    start: { lat: ANCHOR.lat, lon: ANCHOR.lon },
    end: { lat: ANCHOR.lat + 0.07, lon: ANCHOR.lon },
    via: [
      { lat: ANCHOR.lat, lon: ANCHOR.lon },
      { lat: ANCHOR.lat + 0.035, lon: ANCHOR.lon + 0.01 },
      { lat: ANCHOR.lat + 0.07, lon: ANCHOR.lon },
    ],
    joined: true,
    roundtrip: false,
    website: "https://beispiel.test/weg",
    wikipedia: null,
    difficulty: "T2",
    ...overrides,
  };
}

let geo: InMemoryGeoClient;
let ownerId = 0;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `gpx-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = user.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(ownerId),
    permissions: ["photos.view"],
  });
  await db.insert(osmRegionImports).values({
    slug: "italy/nord-est",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: "nom_garda",
    bbox_min_lat: 45.5,
    bbox_min_lon: 10.5,
    bbox_max_lat: 46.2,
    bbox_max_lon: 11.2,
    status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_garda", []);
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function plan() {
  const { plan } = await createTripPlan({ legs: [{ title: "Beispielstadt", anchor: ANCHOR }] });
  return plan;
}

describe("reading a route reference", () => {
  it("takes a relation and nothing else", () => {
    // A signposted way is a relation. A node or way ref arriving here
    // means somebody is exporting the wrong kind of thing.
    expect(relationId("relation:123")).toBe(123);
    expect(relationId(" relation:123 ")).toBe(123);
    expect(relationId("way:123")).toBeNull();
    expect(relationId("node:123")).toBeNull();
    expect(relationId("relation:0")).toBeNull();
    expect(relationId("relation:-1")).toBeNull();
    expect(relationId("relation:abc")).toBeNull();
    expect(relationId("")).toBeNull();
  });
});

describe("the file", () => {
  it("comes back as a track with a name somebody can find again", async () => {
    const p = await plan();
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:7", id: 7 })]);

    const result = await routeGpx(ownerId, { planId: p.id, osmRef: "relation:7" }, {
      geo,
      now: () => TIME,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filename).toBe("panoramaweg-beispiel.gpx");
    expect(result.gpx).toContain("<trk>");
    expect(result.gpx).toContain("<trkpt");
    expect(result.gpx).toContain("<name>Panoramaweg Beispiel</name>");
    expect(result.gpx).toContain("OSM relation:7");
    expect(result.gpx).toContain("OpenStreetMap");
  });

  it("takes the route off the leg that was asked for", async () => {
    // A trip through two cities has two regions and two sets of ways.
    // Exporting the second city's route while the first leg is named
    // would look up the wrong region.
    const { plan: p } = await createTripPlan({
      legs: [
        { title: "Beispielstadt", anchor: ANCHOR },
        { title: "Zweitstadt", anchor: { lat: 45.95, lon: 10.9 } },
      ],
    });
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:7", id: 7 })]);

    const result = await routeGpx(ownerId, {
      planId: p.id,
      osmRef: "relation:7",
      legIndex: 1,
    }, { geo, now: () => TIME });

    expect(result.ok).toBe(true);
  });
});

describe("the answers that are not a file", () => {
  it("refuses a reference that is not a relation", async () => {
    const p = await plan();
    const result = await routeGpx(ownerId, { planId: p.id, osmRef: "way:7" }, { geo });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("does not hand out somebody else's plan", async () => {
    // The whole reason the lookup goes through a plan: without it,
    // naming a region and a relation id would be enough.
    const p = await plan();
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:7", id: 7 })]);

    const result = await routeGpx(ownerId + 1, { planId: p.id, osmRef: "relation:7" }, { geo });

    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("says when the leg is not there", async () => {
    const p = await plan();
    const result = await routeGpx(ownerId, {
      planId: p.id,
      osmRef: "relation:7",
      legIndex: 9,
    }, { geo });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("says when nobody has imported the region", async () => {
    // The plan first, then the region away: creating a plan for a
    // place no region covers goes out to Geofabrik to ask which
    // extract it would need, and that is not what this test is about.
    const p = await plan();
    await db.delete(osmRegionImports);
    clearRouterCache();

    const result = await routeGpx(ownerId, { planId: p.id, osmRef: "relation:7" }, { geo });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(412);
    expect(result.message).toMatch(/Region/);
  });

  it("says when a re-import dropped the relation", async () => {
    // A link somebody saved yesterday outliving a re-import is
    // ordinary, and the sentence says what happened rather than
    // failing silently.
    const p = await plan();
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:7", id: 7 })]);

    const result = await routeGpx(ownerId, { planId: p.id, osmRef: "relation:99" }, { geo });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(result.message).toMatch(/nicht mehr vorhanden/);
  });

  it("says when a region predates the route import", async () => {
    const p = await plan();
    // Nothing seeded: a region nobody has called setRoutes for reads
    // as one imported before routes existed.

    const result = await routeGpx(ownerId, { planId: p.id, osmRef: "relation:7" }, { geo });

    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses to write a file for a relation with no course", async () => {
    const p = await plan();
    geo.setRoutes("nom_garda", [route({
      osmRef: "relation:7",
      id: 7,
      via: [],
      end: null,
      joined: false,
    })]);

    const result = await routeGpx(ownerId, { planId: p.id, osmRef: "relation:7" }, { geo });

    // An empty track imports as an empty tour, which looks like the
    // export worked.
    expect(result).toMatchObject({ ok: false, status: 422 });
  });

  it("says the region is unreachable rather than failing", async () => {
    const p = await plan();
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:7", id: 7 })]);
    geo.failSearchFor("nom_garda");

    const result = await routeGpx(ownerId, { planId: p.id, osmRef: "relation:7" }, { geo });

    expect(result).toMatchObject({ ok: false, status: 503 });
  });
});
