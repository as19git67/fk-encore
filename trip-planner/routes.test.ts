/**
 * Finding a signposted way and taking it into a trip (§4.7).
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
import { createTripPlan, getTripPlan } from "./plans";
import { nearbyRoutes, takeRoute } from "./routes";
import { addTraveller } from "./travellers";

vi.mock("~encore/auth", () => ({ getAuthData: vi.fn() }));

const ANCHOR = { lat: 45.88, lon: 10.84 };

function route(overrides: Partial<GeoRoute> & { osmRef: string }): GeoRoute {
  return {
    id: 1,
    name: "Panoramaweg Beispiel",
    route: "hiking",
    network: "lwn",
    ref: null,
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
    website: null,
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
    .values({ email: `routes-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
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

describe("GET /trip-planner/plans/:planId/routes", () => {
  it("answers the ways that pass near the city", async () => {
    const p = await plan();
    geo.setRoutes("nom_garda", [
      route({ osmRef: "relation:1" }),
      route({ osmRef: "relation:2", name: "Fernweg Beispiel", distanceM: 40_000 }),
    ]);

    const res = await nearbyRoutes({ planId: p.id, radiusM: 15_000 });
    expect(res.imported).toBe(true);
    expect(res.routes.map((r) => r.osmRef)).toEqual(["relation:1"]);
    expect(res.note).toBeNull();
  });

  it("carries the course, so the list can be looked at rather than read", async () => {
    // A row of names is not a decision: two ten-kilometre walks out
    // of the same town are not the same walk, and only the shape
    // says which is which (§4.7).
    const p = await plan();
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:1" })]);

    const res = await nearbyRoutes({ planId: p.id });

    expect(res.routes[0].via).toHaveLength(3);
    expect(res.routes[0].via[0]).toEqual({ lat: ANCHOR.lat, lon: ANCHOR.lon });
    expect(res.routes[0].start).toEqual({ lat: ANCHOR.lat, lon: ANCHOR.lon });
  });

  it("names the start even for a way with no course", async () => {
    // A relation whose members do not join up has no shape to draw.
    // Where it begins is then the one thing known about it, and the
    // screen shows that rather than nothing.
    const p = await plan();
    geo.setRoutes("nom_garda", [
      route({ osmRef: "relation:1", via: [], end: null, joined: false }),
    ]);

    const res = await nearbyRoutes({ planId: p.id });

    expect(res.routes[0].via).toEqual([]);
    expect(res.routes[0].start).toEqual({ lat: ANCHOR.lat, lon: ANCHOR.lon });
  });

  it("estimates a duration from the way's own numbers", async () => {
    // Ten kilometres with six hundred metres of climb: the concept's
    // own example, three and a half hours on foot.
    const p = await plan();
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:1" })]);
    const res = await nearbyRoutes({ planId: p.id });
    expect(res.routes[0].estimatedMinutes).toBe(210);
  });

  it("times a cycling route as a ride, whatever the city does on foot", async () => {
    const p = await plan();
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:1", route: "bicycle" })]);
    const res = await nearbyRoutes({ planId: p.id });
    expect(res.routes[0].estimatedMinutes).toBe(110);
  });

  it("says a region predating the import has none, rather than showing an empty list", async () => {
    // Nobody called setRoutes: this region was imported before the
    // planner knew about ways.
    const p = await plan();
    const res = await nearbyRoutes({ planId: p.id });
    expect(res.imported).toBe(false);
    expect(res.routes).toEqual([]);
    expect(res.note).toMatch(/neuer Import/);
  });

  it("says plainly when the region is there but holds no way", async () => {
    const p = await plan();
    geo.setNoRoutes("nom_garda");
    const res = await nearbyRoutes({ planId: p.id });
    expect(res.imported).toBe(true);
    expect(res.note).toMatch(/keine ausgeschilderte Strecke/);
  });

  it("marks what the trip already holds", async () => {
    const p = await plan();
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:1" })]);
    expect((await nearbyRoutes({ planId: p.id })).routes[0].inPool).toBe(false);

    await takeRoute({ planId: p.id, osmRef: "relation:1" });
    expect((await nearbyRoutes({ planId: p.id })).routes[0].inPool).toBe(true);
  });
});

describe("POST /trip-planner/plans/:planId/routes", () => {
  it("takes the way in with its ends, its length and its shape", async () => {
    const p = await plan();
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:1" })]);

    const res = await takeRoute({ planId: p.id, osmRef: "relation:1" });
    expect(res.dwellMinutes).toBe(210);
    expect(res.roundtrip).toBe(false);

    const { plan: after } = await getTripPlan({ planId: p.id });
    const entry = after.legs[0].pool.find((c) => c.name === "Panoramaweg Beispiel");
    expect(entry?.category).toBe("route");
    const extent = (entry as { extent?: { lengthM?: number; via?: unknown[] } }).extent;
    expect(extent?.lengthM).toBe(10_000);
    // The shape is what lets the corridor follow a bend (§4.7).
    expect(extent?.via).toHaveLength(3);
  });

  it("lets the traveller overrule the estimate", async () => {
    const p = await plan();
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:1" })]);
    const res = await takeRoute({ planId: p.id, osmRef: "relation:1", dwellMinutes: 300 });
    expect(res.dwellMinutes).toBe(300);
  });

  it("takes a loop in finishing where it began, keeping its length", async () => {
    // A loop has an end — it is its start. Saying so keeps the way's
    // length and shape, which a bare point would throw away, and the
    // day still carries on from where it set off (§4.7).
    const p = await plan();
    geo.setRoutes("nom_garda", [
      route({ osmRef: "relation:1", name: "Rundweg Beispiel", end: null, roundtrip: true }),
    ]);

    const res = await takeRoute({ planId: p.id, osmRef: "relation:1" });
    expect(res.roundtrip).toBe(true);

    const { plan: after } = await getTripPlan({ planId: p.id });
    const entry = after.legs[0].pool.find((c) => c.name === "Rundweg Beispiel");
    const extent = (entry as { extent?: { end: { lat: number }; lengthM?: number } }).extent;
    expect(extent?.end.lat).toBeCloseTo(ANCHOR.lat, 5);
    expect(extent?.lengthM).toBe(10_000);
  });

  it("claims no course for a relation whose members do not join up", async () => {
    // Gaps, branches, signposted alternates: we cannot say where it
    // runs, so we say nothing rather than a plausible shape (§15.3).
    const p = await plan();
    geo.setRoutes("nom_garda", [
      route({ osmRef: "relation:1", name: "Lückenweg Beispiel", end: null, joined: false, via: [] }),
    ]);

    await takeRoute({ planId: p.id, osmRef: "relation:1" });
    const { plan: after } = await getTripPlan({ planId: p.id });
    const entry = after.legs[0].pool.find((c) => c.name === "Lückenweg Beispiel");
    expect((entry as { extent?: unknown }).extent).toBeFalsy();
  });

  it("keeps the map's own reference, so the trip can recognise it again", async () => {
    const p = await plan();
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:1" })]);
    await takeRoute({ planId: p.id, osmRef: "relation:1" });

    const { plan: after } = await getTripPlan({ planId: p.id });
    expect(after.legs[0].pool.map((c) => c.osmRef)).toContain("relation:1");
  });

  it("refuses a way that is not near this city", async () => {
    const p = await plan();
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:1" })]);
    await expect(takeRoute({ planId: p.id, osmRef: "relation:999" }))
      .rejects.toThrow(/nicht in der Nähe/);
  });

  it("says why when the region has no routes imported at all", async () => {
    const p = await plan();
    await expect(takeRoute({ planId: p.id, osmRef: "relation:1" }))
      .rejects.toThrow(/noch keine Strecken importiert/);
  });
});

describe("who is coming, and what that does to the list (§3.5)", () => {
  it("stretches every estimate for a group that walks slower", async () => {
    // Dated on purpose: an age is computed against the trip's start,
    // and without a date the group derives nothing (§3.5).
    const { plan: p } = await createTripPlan({
      legs: [{ title: "Beispielstadt", anchor: ANCHOR, startDate: "2027-06-01" }],
    });
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:1" })]);
    const before = (await nearbyRoutes({ planId: p.id })).routes[0].estimatedMinutes;

    // A five-year-old: the group walks three kilometres an hour, not
    // four, and the way takes what it takes.
    await addTraveller({ planId: p.id, label: "Kind Beispiel", birthDate: "2021-06-15" });

    const after = (await nearbyRoutes({ planId: p.id })).routes[0].estimatedMinutes;
    expect(after).toBeGreaterThan(before);
    expect(after).toBe(Math.round(before * 1.4));
  });

  it("leaves a hiking route off the list when somebody is on wheels", async () => {
    const p = await plan();
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:1" })]);
    await addTraveller({ planId: p.id, label: "Oma Beispiel", getsAbout: "wheelchair" });

    const res = await nearbyRoutes({ planId: p.id });

    expect(res.routes).toEqual([]);
    expect(res.omittedForWheels).toBe(1);
    // Never silently: an empty list reads as a region with nothing in
    // it, which is a different thing (§15.3).
    expect(res.note).toMatch(/Rollstuhl/);
  });

  it("keeps a level way on made ground", async () => {
    const p = await plan();
    geo.setRoutes("nom_garda", [
      route({ osmRef: "relation:1", name: "Seepromenade Beispiel", route: "foot", ascentM: 0 }),
      route({ osmRef: "relation:2", name: "Bergweg Beispiel", ascentM: 600 }),
    ]);
    await addTraveller({ planId: p.id, label: "Oma Beispiel", getsAbout: "pram" });

    const res = await nearbyRoutes({ planId: p.id });

    expect(res.routes.map((r) => r.name)).toEqual(["Seepromenade Beispiel"]);
    expect(res.omittedForWheels).toBe(1);
  });

  it("changes nothing for an ordinary group", async () => {
    const p = await plan();
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:1" })]);

    const res = await nearbyRoutes({ planId: p.id });

    expect(res.routes).toHaveLength(1);
    expect(res.omittedForWheels).toBe(0);
    expect(res.note).toBeNull();
  });

  it("still lets somebody take a way in deliberately", async () => {
    // The list is a suggestion, not a gate: refusing what a person
    // asked for by name would be the planner overruling them (§7.1).
    const p = await plan();
    geo.setRoutes("nom_garda", [route({ osmRef: "relation:1" })]);
    await addTraveller({ planId: p.id, label: "Oma Beispiel", getsAbout: "wheelchair" });

    const res = await takeRoute({ planId: p.id, osmRef: "relation:1" });
    expect(res.name).toBe("Panoramaweg Beispiel");
  });
});
