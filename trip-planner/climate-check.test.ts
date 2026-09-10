/**
 * The precautions a climate normal produces (§7.2).
 *
 * The limit is what these cases are about: a monthly average may leave
 * a day empty and report a thin pool, and it may do nothing else. In
 * particular it must stay out of the fortnight where a real forecast
 * exists, and it must not turn a trip down when the service is
 * unreachable.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { climateCheck } from "./climate-check";
import { clearClimateCache } from "./climate-precautions";
import { loadPlan } from "./plan-store";
import { createTripPlan } from "./plans";
import type { ClimateClient, ClimateNormal } from "./weather-client";
import { setClimateClient } from "./weather-client";

const MUNICH = { lat: 48.14, lon: 11.58 };
const DB = "nom_west";

function spot(n: number, category: string, kind: string): GeoPoiSearchSpot {
  return {
    osmRef: `way:${n}`,
    type: "way",
    id: n,
    lat: MUNICH.lat + n * 0.0002,
    lon: MUNICH.lon,
    distanceM: n * 22,
    detourM: null,
    name: `Ort ${n}`,
    nameDe: null,
    nameEn: null,
    kind,
    categories: [category],
    wikidataQid: `Q${n}`,
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

/** A climate service that answers whatever the test needs. */
class StubClimate implements ClimateClient {
  normalToReturn: ClimateNormal = {
    month: 9,
    meanTemperatureC: 21,
    precipitationMm: 210,
    wetDays: 12,
    source: "open-meteo-climate",
  };
  failing = false;

  async normal(_lat: number, _lon: number, month: number): Promise<ClimateNormal> {
    if (this.failing) throw new Error("climate-api unreachable");
    return { ...this.normalToReturn, month };
  }
}

let ownerId = 0;
let climate: StubClimate;

/** Far past the forecast horizon, so the normal is what speaks. */
function farAhead(days = 200): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Inside the horizon, where a real forecast exists. */
function soon(days = 3): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = `${Date.now()}-${Math.random()}`;
  const [row] = await db
    .insert(users)
    .values({ email: `klima-${stamp}@test.invalid`, name: "Planerin", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = row.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(ownerId),
    permissions: ["photos.view"],
  });

  await db.insert(osmRegionImports).values({
    slug: "europe/west",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: DB,
    bbox_min_lat: 47.9,
    bbox_min_lon: 11.2,
    bbox_max_lat: 48.5,
    bbox_max_lon: 11.9,
    status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  // All outdoors, so the pool is deterministically thin on wet-weather
  // options — which is the case the report exists for.
  geo.setSearchSpots(DB, Array.from({ length: 24 },
    (_, i) => spot(i + 1, "viewpoint", "tourism=viewpoint")));
  setGeoClient(geo);
  climate = new StubClimate();
  setClimateClient(climate);
  clearClimateCache();
  return () => resetGeoClient();
});

describe("a trip beyond the forecast horizon", () => {
  it("leaves one day of the leg empty, with the reason on it", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "München", anchor: MUNICH, startDate: farAhead(), days: 5 }],
    });

    const stored = await loadPlan(plan.id, ownerId);
    const buffered = stored!.legs[0].days.filter((day) => day.bufferReason);
    expect(buffered).toHaveLength(1);
    expect(buffered[0].bufferReason).toContain("Regentage");
    // Empty on purpose, not for lack of candidates.
    expect(buffered[0].blocks.every((b) => b.stops.length === 0)).toBe(true);
  });

  it("puts the buffer in the middle, not on the arrival or the departure", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "München", anchor: MUNICH, startDate: farAhead(), days: 5 }],
    });

    const stored = await loadPlan(plan.id, ownerId);
    const index = stored!.legs[0].days.find((day) => day.bufferReason)?.dayIndex;
    expect(index).toBe(2);
  });

  it("says what the month asks for and how thin the pool is", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "München", anchor: MUNICH, startDate: farAhead(), days: 5 }],
    });

    const { legs } = await climateCheck({ planId: plan.id });

    expect(legs[0].reasons.join(" ")).toContain("Regentage");
    expect(legs[0].sentence).toBeTruthy();
    expect(legs[0].wantedIndoorShare).toBeGreaterThan(0);
  });

  it("counts how many more sheltered spots it would take, not just 'too few'", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "München", anchor: MUNICH, startDate: farAhead(), days: 5 }],
    });

    const { legs } = await climateCheck({ planId: plan.id });

    expect(legs[0].indoorShare).toBe(0);
    expect(legs[0].shortfall).toBeGreaterThan(0);
    expect(legs[0].sentence).toContain("Museen");
  });
});

describe("what it must not do", () => {
  it("stays out of the fortnight where a real forecast exists", async () => {
    // §7.2: "Erst in den letzten zwei Wochen schaltet sich die echte
    // Vorhersage tageweise zu" — and then the average has nothing to add.
    const { plan } = await createTripPlan({
      legs: [{ title: "München", anchor: MUNICH, startDate: soon(), days: 5 }],
    });

    const stored = await loadPlan(plan.id, ownerId);
    expect(stored!.legs[0].days.some((day) => day.bufferReason)).toBe(false);
    const { legs } = await climateCheck({ planId: plan.id });
    expect(legs[0].reasons).toEqual([]);
    expect(legs[0].sentence).toBeNull();
  });

  it("says nothing about a mild month", async () => {
    climate.normalToReturn = {
      month: 5, meanTemperatureC: 16, precipitationMm: 55, wetDays: 8,
      source: "open-meteo-climate",
    };
    const { plan } = await createTripPlan({
      legs: [{ title: "München", anchor: MUNICH, startDate: farAhead(), days: 5 }],
    });

    const stored = await loadPlan(plan.id, ownerId);
    expect(stored!.legs[0].days.some((day) => day.bufferReason)).toBe(false);
    expect((await climateCheck({ planId: plan.id })).legs[0].sentence).toBeNull();
  });

  it("plans the trip anyway when the climate service is unreachable", async () => {
    // A thirty-year average is a nicety; a trip is not.
    climate.failing = true;

    const { plan } = await createTripPlan({
      legs: [{ title: "München", anchor: MUNICH, startDate: farAhead(), days: 5 }],
    });

    expect(plan.legs[0].days).toHaveLength(5);
    const stored = await loadPlan(plan.id, ownerId);
    expect(stored!.legs[0].days.some((day) => day.bufferReason)).toBe(false);
  });

  it("takes no day from a leg too short to spare one", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "München", anchor: MUNICH, startDate: farAhead(), days: 2 }],
    });

    const stored = await loadPlan(plan.id, ownerId);
    expect(stored!.legs[0].days.some((day) => day.bufferReason)).toBe(false);
    expect((await climateCheck({ planId: plan.id })).legs[0].sentence).toContain("zu kurz");
  });

  it("does not open somebody else's trip", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "München", anchor: MUNICH, startDate: farAhead(), days: 5 }],
    });
    const [other] = await db
      .insert(users)
      .values({
        email: `fremd-${Date.now()}${Math.random()}@test.invalid`,
        name: "Fremde",
        password_hash: "x",
      })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(other.id),
      permissions: ["photos.view"],
    });

    await expect(climateCheck({ planId: plan.id })).rejects.toThrow(/plan not found/);
  });
});
