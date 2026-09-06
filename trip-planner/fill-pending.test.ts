/**
 * A trip whose maps arrive later (§4.3).
 *
 * The promise the planner makes when it saves a trip for a place it has
 * no region for is "gerahmt, noch nicht gefüllt" — which is only a
 * promise if something eventually fills it. Nothing did: the import
 * finished and the trip sat there empty.
 *
 * The two things worth pinning are the ones that look right and are
 * not. A leg with no stops is *not* the same as a leg waiting for its
 * region — a search that genuinely found nothing looks identical, and a
 * worker that could not tell them apart would re-plan that trip every
 * quarter of an hour for ever. And a trip somebody has already begun is
 * a record of what happened, not a frame to fill.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports, tripPlanLegs, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";

vi.mock("../osm-admin/region.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../osm-admin/region.service")>();
  return {
    ...actual,
    suggestForCoord: async () => ({
      slug: "europe/portugal",
      pbfUrl: "https://example.com/pt.pbf",
      pbfSizeMb: 400,
      autoApprove: false,
    }),
    createPending: async () => ({
      slug: "europe/portugal",
      status: "pending_approval" as const,
      created: true,
    }),
  };
});

import { createTripPlan, getTripPlan, setTripStopStatus } from "./plans";
import { fillWaitingPlans } from "./fill-pending";

/** Somewhere with no imported region at the start. */
const LISBON = { lat: 38.71, lon: -9.14 };
/** And somewhere that has one all along. */
const WEST = { lat: 48.37, lon: 10.9 };

function spot(n: number, at: { lat: number; lon: number }): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: at.lat + n * 0.0005,
    lon: at.lon,
    distanceM: n * 60,
    detourM: null,
    name: `Museum ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: `Q${n}`,
    wikipedia: `de:Museum ${n}`,
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

/** The import finishes: the region is registered and holds spots. */
async function portugalArrives() {
  await db.insert(osmRegionImports).values({
    slug: "europe/portugal",
    geofabrik_url: "https://example.com/pt.pbf",
    postgres_db: "nom_pt",
    bbox_min_lat: 36.9,
    bbox_min_lon: -9.6,
    bbox_max_lat: 42.2,
    bbox_max_lon: -6.1,
    status: "ready_running",
  });
  clearRouterCache();
  geo.setSearchSpots("nom_pt", Array.from({ length: 8 }, (_, i) => spot(i + 1, LISBON)));
}

const stopCount = (p: { legs: { days: { blocks: { stops: unknown[] }[] }[] }[] }) =>
  p.legs.reduce((n, leg) =>
    n + leg.days.reduce((m, d) =>
      m + d.blocks.reduce((k, b) => k + b.stops.length, 0), 0), 0);

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `fill-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(user.id),
    permissions: ["photos.view"],
  });
  await db.insert(osmRegionImports).values({
    slug: "europe/west",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: "nom_west",
    bbox_min_lat: 48.2,
    bbox_min_lon: 10.5,
    bbox_max_lat: 48.6,
    bbox_max_lon: 11.2,
    status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", Array.from({ length: 8 }, (_, i) => spot(i + 1, WEST)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("a trip waiting for its region", () => {
  it("says it is waiting, rather than looking like an empty trip", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "Lissabon", anchor: LISBON, days: 2 }],
    });
    expect(plan.legs[0].awaitingRegion).toBe(true);
    expect(stopCount(plan)).toBe(0);
  });

  it("fills itself in once the import lands", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "Lissabon", anchor: LISBON, days: 2 }],
    });
    await portugalArrives();

    const outcomes = await fillWaitingPlans();

    expect(outcomes).toEqual([{ planId: plan.id, result: "filled" }]);
    const { plan: filled } = await getTripPlan({ planId: plan.id });
    expect(stopCount(filled)).toBeGreaterThan(0);
    expect(filled.legs[0].awaitingRegion).toBe(false);
  });

  it("keeps the frame the traveller set", async () => {
    // Dates, anchor, mode and radius are what they typed; only the
    // solver's choice of spots was missing.
    const { plan } = await createTripPlan({
      legs: [{
        title: "Lissabon", anchor: LISBON, days: 2, mode: "transit",
        radiusM: 4_000, startDate: "2026-09-17",
      }],
    });
    await portugalArrives();
    await fillWaitingPlans();

    const { plan: filled } = await getTripPlan({ planId: plan.id });
    expect(filled.legs[0].startDate).toBe("2026-09-17");
    expect(filled.legs[0].mode).toBe("transit");
    expect(filled.legs[0].radiusM).toBe(4_000);
    expect(filled.legs[0].days).toHaveLength(2);
  });

  it("does nothing at all while the region is still missing", async () => {
    await createTripPlan({ legs: [{ title: "Lissabon", anchor: LISBON, days: 2 }] });

    const outcomes = await fillWaitingPlans();

    expect(outcomes.map((o) => o.result)).toEqual(["still-waiting"]);
    // And no search was wasted on it.
    expect(geo.getSearchCalls().some((c) => c.postgresDb === "nom_pt")).toBe(false);
  });

  it("waits for the last leg before filling any of them", async () => {
    // Re-planning rewrites the whole trip, so filling it now would
    // give the second city empty days a second time — and re-plan the
    // first one for nothing.
    const { plan } = await createTripPlan({
      legs: [
        { title: "Weststadt", anchor: WEST, days: 1, radiusM: 4_000 },
        { title: "Lissabon", anchor: LISBON, days: 2 },
      ],
    });
    expect(plan.legs[0].awaitingRegion).toBe(false);
    expect(plan.legs[1].awaitingRegion).toBe(true);

    expect((await fillWaitingPlans()).map((o) => o.result)).toEqual(["still-waiting"]);

    await portugalArrives();
    expect((await fillWaitingPlans()).map((o) => o.result)).toEqual(["filled"]);
    const { plan: filled } = await getTripPlan({ planId: plan.id });
    expect(filled.legs.every((l) => l.awaitingRegion === false)).toBe(true);
    expect(filled.legs[1].days.some((d) =>
      d.blocks.some((b) => b.stops.length > 0))).toBe(true);
  });

  it("leaves a trip somebody has already begun alone", async () => {
    // Two legs: the first is planned and has been walked, the second
    // was waiting. Re-planning would rewrite the day that happened.
    const { plan } = await createTripPlan({
      legs: [
        { title: "Weststadt", anchor: WEST, days: 1, radiusM: 4_000 },
        { title: "Lissabon", anchor: LISBON, days: 2 },
      ],
    });
    const stop = plan.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    await setTripStopStatus({ planId: plan.id, stopId: stop.rowId, status: "done" });
    await portugalArrives();

    const outcomes = await fillWaitingPlans();

    expect(outcomes[0].result).toBe("begun");
    // The flag stays set: the trip is still waiting, and saying so
    // beats a silent no-op the traveller cannot see.
    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(after.legs[1].awaitingRegion).toBe(true);
  });

  it("does not come back for a leg whose search simply found nothing", async () => {
    // The reason the flag exists. This leg's region is imported and
    // empty — indistinguishable from a waiting leg by "has no stops",
    // and re-planning it every quarter of an hour for ever would be
    // the result of guessing.
    geo.setSearchSpots("nom_west", []);
    const { plan } = await createTripPlan({
      legs: [{ title: "Weststadt", anchor: WEST, days: 1, radiusM: 4_000 }],
    });
    expect(stopCount(plan)).toBe(0);
    expect(plan.legs[0].awaitingRegion).toBe(false);

    expect(await fillWaitingPlans()).toEqual([]);
  });

  it("survives a plan that was deleted between the query and the fill", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "Lissabon", anchor: LISBON, days: 2 }],
    });
    await portugalArrives();
    await db.delete(tripPlans).where(eq(tripPlans.id, plan.id));

    // The leg rows cascade with the plan, so there is nothing left to
    // do — and nothing to throw about either.
    expect(await fillWaitingPlans()).toEqual([]);
  });

  it("clears the flag on the legs it filled, not on all of them", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "Lissabon", anchor: LISBON, days: 1 }],
    });
    const legs = await db
      .select({ awaiting: tripPlanLegs.awaiting_region })
      .from(tripPlanLegs)
      .where(eq(tripPlanLegs.plan_id, plan.id));
    expect(legs.map((l) => l.awaiting)).toEqual([true]);

    await portugalArrives();
    await fillWaitingPlans();

    const after = await db
      .select({ awaiting: tripPlanLegs.awaiting_region })
      .from(tripPlanLegs)
      .where(eq(tripPlanLegs.plan_id, plan.id));
    expect(after.map((l) => l.awaiting)).toEqual([false]);
  });
});
