/**
 * Offering a day rearranged for the weather (§7.2, §7.1).
 *
 * The cases worth pinning down are all about consent and freshness:
 * a proposal changes nothing on disk, an apply changes something,
 * and neither invents a forecast it does not have.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users, weatherForecastCache } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan } from "./plans";
import { applyWeatherReplan, weatherProposal } from "./weather-replan";
import type { ForecastHour } from "./weather";
import {
  resetWeatherClient,
  setWeatherClient,
  WeatherUnavailableError,
  type Forecast,
  type WeatherClient,
} from "./weather-client";

const MUNICH = { lat: 48.14, lon: 11.58 };

/**
 * Outdoor and indoor spots alternate, so a wet block always has
 * something to swap and something to swap for.
 */
function spot(n: number): GeoPoiSearchSpot {
  const kind = n % 2 === 0 ? "leisure=park" : "tourism=museum";
  return {
    osmRef: `way:${n}`,
    type: "way",
    id: n,
    lat: MUNICH.lat + n * 0.0004,
    lon: MUNICH.lon + (n % 3) * 0.0003,
    distanceM: n * 50,
    detourM: null,
    name: `Ort ${n}`,
    nameDe: null,
    nameEn: null,
    kind,
    categories: ["sight"],
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

class StubClient implements WeatherClient {
  fail: Error | null = null;
  precipitationMm = 0;
  temperatureC = 18;

  async forecast(lat: number, lon: number, from: string): Promise<Forecast> {
    if (this.fail) throw this.fail;
    const hours: ForecastHour[] = Array.from({ length: 24 }, (_, i) => ({
      time: `${from}T${String(i).padStart(2, "0")}:00:00Z`,
      precipitationMm: this.precipitationMm,
      cloudCover: 80,
      temperatureC: this.temperatureC,
      relativeHumidity: 60,
    }));
    return { lat, lon, hours };
  }
}

let ownerId = 0;
let weather: StubClient;

/** Inside the forecast horizon, whenever the suite happens to run. */
function soon(offsetDays = 1): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  await db.delete(weatherForecastCache);
  clearRouterCache();
  const stamp = Date.now() + Math.random();
  const [row] = await db
    .insert(users)
    .values({ email: `umraeumen-${stamp}@test.invalid`, name: "Planerin", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = row.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(ownerId),
    permissions: ["photos.view"],
  });

  await db.insert(osmRegionImports).values({
    slug: "europe/west",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: "nom_west",
    bbox_min_lat: 47.9,
    bbox_min_lon: 11.2,
    bbox_max_lat: 48.5,
    bbox_max_lon: 11.9,
    status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", Array.from({ length: 24 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  weather = new StubClient();
  setWeatherClient(weather);
  return () => {
    resetGeoClient();
    resetWeatherClient();
  };
});

async function trip(days = 1) {
  const { plan } = await createTripPlan({
    legs: [{ title: "München", anchor: MUNICH, days, startDate: soon() }],
  });
  return plan;
}

/** A trip nobody has placed in the year yet (§4.3). */
async function undatedTrip() {
  const { plan } = await createTripPlan({ legs: [{ title: "München", anchor: MUNICH }] });
  return plan;
}

function stopRefs(days: { blocks: { stops: { osmRef: string }[] }[] }[], dayIndex = 0): string[] {
  return days[dayIndex].blocks.flatMap((b) => b.stops.map((s) => s.osmRef));
}

describe("proposing a day rearranged for the weather", () => {
  it("offers moves in the wet and saves nothing", async () => {
    weather.precipitationMm = 3;
    const plan = await trip();
    const before = JSON.stringify(plan.legs[0].days);

    const proposal = await weatherProposal({ planId: plan.id, dayIndex: 0, utcOffsetMinutes: 120 });

    expect(proposal.offered).toBe(true);
    expect(proposal.reason).toBe("ok");
    expect(proposal.moves.length).toBeGreaterThan(0);
    expect(proposal.blocks.length).toBeGreaterThan(0);

    // The whole point of a proposal: the day on disk is untouched.
    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(JSON.stringify(after.legs[0].days)).toBe(before);
  });

  it("offers nothing on a day the weather has no quarrel with", async () => {
    // A prompt that proposes nothing teaches people to dismiss prompts.
    const plan = await trip();

    const proposal = await weatherProposal({ planId: plan.id, dayIndex: 0, utcOffsetMinutes: 120 });

    expect(proposal.offered).toBe(false);
    expect(proposal.reason).toBe("nothing-to-move");
    expect(proposal.moves).toEqual([]);
  });

  it("says there is no forecast rather than that there is nothing to do", async () => {
    weather.fail = new WeatherUnavailableError("open-meteo answered 503");
    const plan = await trip();

    const proposal = await weatherProposal({ planId: plan.id, dayIndex: 0, utcOffsetMinutes: 120 });

    expect(proposal.offered).toBe(false);
    expect(proposal.reason).toBe("no-forecast");
  });

  it("says a trip without dates has no weather to plan around", async () => {
    const plan = await undatedTrip();

    const proposal = await weatherProposal({ planId: plan.id, dayIndex: 0 });

    expect(proposal.offered).toBe(false);
    expect(proposal.reason).toBe("no-dates");
  });

  it("refuses a day that is not planned out yet", async () => {
    // A day at trip resolution has a frame and no stops (§4.3).
    weather.precipitationMm = 3;
    const plan = await trip(4);

    await expect(
      weatherProposal({ planId: plan.id, dayIndex: 3, utcOffsetMinutes: 120 }),
    ).rejects.toThrow(/noch nicht ausgeplant/);
  });
});

describe("applying a day rearranged for the weather", () => {
  it("changes the day, and reports what it changed", async () => {
    weather.precipitationMm = 3;
    const plan = await trip();
    const before = stopRefs(plan.legs[0].days);

    const applied = await applyWeatherReplan({
      planId: plan.id,
      dayIndex: 0,
      utcOffsetMinutes: 120,
    });

    expect(applied.moves.length).toBeGreaterThan(0);
    const after = stopRefs(applied.plan.legs[0].days);
    expect(after).not.toEqual(before);

    // And it is the saved plan that changed, not just the answer.
    const { plan: reloaded } = await getTripPlan({ planId: plan.id });
    expect(stopRefs(reloaded.legs[0].days)).toEqual(after);
  });

  it("leaves a dry day exactly as it was", async () => {
    const plan = await trip();
    const before = JSON.stringify(plan.legs[0].days);

    const applied = await applyWeatherReplan({
      planId: plan.id,
      dayIndex: 0,
      utcOffsetMinutes: 120,
    });

    expect(applied.moves).toEqual([]);
    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(JSON.stringify(after.legs[0].days)).toBe(before);
  });

  it("refuses to rearrange around a forecast it does not have", async () => {
    weather.fail = new WeatherUnavailableError("open-meteo answered 503");
    const plan = await trip();

    await expect(
      applyWeatherReplan({ planId: plan.id, dayIndex: 0, utcOffsetMinutes: 120 }),
    ).rejects.toThrow(/keine Vorhersage/);
  });

  it("refuses a trip that has no dates", async () => {
    const plan = await undatedTrip();

    await expect(applyWeatherReplan({ planId: plan.id, dayIndex: 0 })).rejects.toThrow(
      /kein Datum/,
    );
  });

  it("does not touch a stop somebody pinned", async () => {
    weather.precipitationMm = 3;
    const plan = await trip();
    const pinnable = plan.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    const { pinTripStop } = await import("./plans");
    await pinTripStop({ planId: plan.id, stopId: pinnable.rowId, pinned: true });

    const applied = await applyWeatherReplan({
      planId: plan.id,
      dayIndex: 0,
      utcOffsetMinutes: 120,
    });

    expect(applied.moves.map((m) => m.osmRef)).not.toContain(pinnable.osmRef);
    expect(stopRefs(applied.plan.legs[0].days)).toContain(pinnable.osmRef);
  });
});
