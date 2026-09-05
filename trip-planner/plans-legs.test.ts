/**
 * Legs, at the endpoint: one trip, several places (§4.2).
 *
 * The persistence side is covered in plan-store.test.ts. What is this
 * endpoint's own is the step before it: turning a request into legs,
 * resolving a region *per leg*, and searching each leg's own area with
 * its own settings. A trip whose second city quietly reused the first
 * one's region would look perfectly fine in the response and be wrong.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
vi.mock("../osm-admin/region.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../osm-admin/region.service")>();
  return {
    ...actual,
    // The region lookup goes to Geofabrik over the network; faked so the
    // suite does not depend on a download.
    suggestForCoord: async () => ({
      slug: "europe/east",
      pbfUrl: "https://example.com/east.pbf",
      pbfSizeMb: 100,
      autoApprove: false,
    }),
    createPending: async () => ({
      slug: "europe/east",
      status: "pending_approval" as const,
      created: true,
    }),
  };
});

import { createTripPlan, listTripPlans } from "./plans";

/** Two invented towns, far enough apart to need two regions. */
const WEST = { lat: 48.37, lon: 10.9 };
const EAST = { lat: 48.14, lon: 11.58 };

async function seedRegion(slug: string, bbox: [number, number, number, number]) {
  await db.insert(osmRegionImports).values({
    slug,
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: "nom_" + slug.replace(/[^a-z0-9]/g, "_"),
    bbox_min_lat: bbox[0],
    bbox_min_lon: bbox[1],
    bbox_max_lat: bbox[2],
    bbox_max_lon: bbox[3],
    status: "ready_running",
  });
}

function spot(ref: string, at: { lat: number; lon: number }): GeoPoiSearchSpot {
  return {
    osmRef: ref,
    type: "node",
    id: Number(ref.split(":")[1]),
    lat: at.lat,
    lon: at.lon,
    distanceM: 100,
    detourM: null,
    name: ref,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: null,
    wikipedia: null,
    openingHours: null,
    cuisine: null,
    wheelchair: null,
    outdoorSeating: null,
    dietVegetarian: null,
    dietVegan: null,
    phone: null,
    website: null,
    facadeAzimuth: null,
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
    .values({ email: `legs-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = user.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(ownerId),
    permissions: ["photos.view"],
  });
  geo = new InMemoryGeoClient();
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("POST /trip-planner/plans with legs", () => {
  it("searches each leg's own region around its own anchor", async () => {
    await seedRegion("europe/west", [48.2, 10.5, 48.6, 11.2]);
    await seedRegion("europe/east", [48.0, 11.3, 48.4, 11.9]);
    geo.setSearchSpots("nom_europe_west", [spot("node:1", WEST)]);
    geo.setSearchSpots("nom_europe_east", [spot("node:2", EAST)]);

    const { plan } = await createTripPlan({
      title: "Zwei Städte",
      legs: [
        { title: "Weststadt", anchor: WEST, days: 2, radiusM: 1_500 },
        { title: "Oststadt", anchor: EAST, mode: "transit", radiusM: 4_000 },
      ],
    });

    const calls = geo.getSearchCalls();
    expect(calls.map((c) => c.postgresDb)).toEqual(["nom_europe_west", "nom_europe_east"]);
    expect(calls[0].query.center).toEqual({ ...WEST, radiusM: 1_500 });
    expect(calls[1].query.center).toEqual({ ...EAST, radiusM: 4_000 });

    expect(plan.legs.map((l) => l.title)).toEqual(["Weststadt", "Oststadt"]);
    expect(plan.legs.map((l) => l.regionDb)).toEqual(["nom_europe_west", "nom_europe_east"]);
    expect(plan.legs.map((l) => l.mode)).toEqual(["foot", "transit"]);
    expect(plan.legs.map((l) => l.days.length)).toEqual([2, 1]);
  });

  it("plans a leg's days out of that leg's candidates only", async () => {
    await seedRegion("europe/west", [48.2, 10.5, 48.6, 11.2]);
    await seedRegion("europe/east", [48.0, 11.3, 48.4, 11.9]);
    geo.setSearchSpots("nom_europe_west", [spot("node:1", WEST)]);
    geo.setSearchSpots("nom_europe_east", [spot("node:2", EAST)]);

    const { plan } = await createTripPlan({
      legs: [{ anchor: WEST }, { anchor: EAST }],
    });

    const refsOf = (i: number) =>
      plan.legs[i].days.flatMap((d) => d.blocks.flatMap((b) => b.stops.map((s) => s.osmRef)));
    expect(refsOf(0)).toEqual(["node:1"]);
    expect(refsOf(1)).toEqual(["node:2"]);
  });

  it("names the leg whose region is missing, and saves the trip anyway", async () => {
    // It used to refuse outright, which threw away everything the
    // traveller had typed over a download they had no way to arrange.
    // §4.3 already has a resolution for "framed but not filled in", so
    // the leg gets its days and the import is asked for.
    await seedRegion("europe/west", [48.2, 10.5, 48.6, 11.2]);
    geo.setSearchSpots("nom_europe_west", [spot("node:1", WEST)]);

    const { plan, pendingRegions } = await createTripPlan({
      legs: [{ anchor: WEST }, { title: "Oststadt", anchor: EAST }],
    });

    expect(pendingRegions).toHaveLength(1);
    expect(pendingRegions?.[0].legTitle).toBe("Oststadt");
    // The western leg was planned as usual; only the eastern one waits.
    expect(plan.legs[0].days[0].blocks.some((b) => b.stops.length > 0)).toBe(true);
    expect(plan.legs[1].days[0].blocks.every((b) => b.stops.length === 0)).toBe(true);
  });

  it("still accepts the flat one-city request and makes one leg of it", async () => {
    await seedRegion("europe/west", [48.2, 10.5, 48.6, 11.2]);
    geo.setSearchSpots("nom_europe_west", [spot("node:1", WEST)]);

    const { plan } = await createTripPlan({ anchor: WEST, days: 3, radiusM: 2_000 });

    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0].days).toHaveLength(3);
    expect(plan.legs[0].mode).toBe("foot");
    expect(geo.getSearchCalls()[0].query.center).toEqual({ ...WEST, radiusM: 2_000 });
  });

  it("records an anchor zone as a tolerance, not as an address", async () => {
    await seedRegion("europe/west", [48.2, 10.5, 48.6, 11.2]);
    geo.setSearchSpots("nom_europe_west", [spot("node:1", WEST)]);

    const { plan } = await createTripPlan({
      legs: [{ anchor: WEST, anchorRadiusM: 1_200, startDate: "2026-09-03" }],
    });

    expect(plan.legs[0].anchorRadiusM).toBe(1_200);
    expect(plan.legs[0].startDate).toBe("2026-09-03");
  });

  it("refuses a request that names neither legs nor an anchor", async () => {
    await expect(createTripPlan({})).rejects.toThrow(/legs or anchor/);
    await expect(createTripPlan({ legs: [] })).rejects.toThrow(/non-empty/);
  });

  it("refuses a mode it cannot plan for", async () => {
    await seedRegion("europe/west", [48.2, 10.5, 48.6, 11.2]);
    await expect(
      // The endpoint is typed, but nothing stops a hand-written request.
      createTripPlan({ legs: [{ anchor: WEST, mode: "helicopter" as never }] }),
    ).rejects.toThrow(/mode must be one of/);
  });

  it("lists the user's plans, newest first, without the whole plan", async () => {
    await seedRegion("europe/west", [48.2, 10.5, 48.6, 11.2]);
    await seedRegion("europe/east", [48.0, 11.3, 48.4, 11.9]);
    geo.setSearchSpots("nom_europe_west", [spot("node:1", WEST)]);
    geo.setSearchSpots("nom_europe_east", [spot("node:2", EAST)]);

    await createTripPlan({ title: "Wochenende", anchor: WEST, days: 2 });
    await createTripPlan({
      title: "Zwei Städte",
      legs: [
        { title: "Weststadt", anchor: WEST, days: 3, startDate: "2026-09-03" },
        { title: "Oststadt", anchor: EAST, days: 2 },
      ],
    });

    const { plans } = await listTripPlans();
    expect(plans.map((p) => p.title)).toEqual(["Zwei Städte", "Wochenende"]);

    const [twoCities] = plans;
    // Enough to choose between trips: a name, a route, a length, a date.
    expect(twoCities.legTitles).toEqual(["Weststadt", "Oststadt"]);
    expect(twoCities.dayCount).toBe(5);
    expect(twoCities.startDate).toBe("2026-09-03");
    // And not the plan itself — a twenty-day trip is hundreds of stops.
    expect(twoCities).not.toHaveProperty("legs");
  });

  it("lists nothing for a user with no plans", async () => {
    await expect(listTripPlans()).resolves.toEqual({ plans: [] });
  });

  it("does not list another user's plans", async () => {
    await seedRegion("europe/west", [48.2, 10.5, 48.6, 11.2]);
    geo.setSearchSpots("nom_europe_west", [spot("node:1", WEST)]);
    await createTripPlan({ title: "Meine Reise", anchor: WEST });

    const [other] = await db
      .insert(users)
      .values({ email: `other-${Date.now()}@test.invalid`, name: "Other", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(other.id),
      permissions: ["photos.view"],
    });

    await expect(listTripPlans()).resolves.toEqual({ plans: [] });
  });

  it("refuses a start date that is not a plain date", async () => {
    await seedRegion("europe/west", [48.2, 10.5, 48.6, 11.2]);
    await expect(
      createTripPlan({ legs: [{ anchor: WEST, startDate: "2026-09-03T12:00:00Z" }] }),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });
});
