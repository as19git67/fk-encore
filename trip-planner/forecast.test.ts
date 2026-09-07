/**
 * The weather on a day of a trip (§7.2).
 *
 * The cases that matter are about what the endpoint refuses to claim:
 * no forecast is answered as no forecast, never as a fine day, and
 * nothing on the plan moves because it rained.
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
import { dayForecast } from "./forecast";
import type { ForecastHour } from "./weather";
import {
  resetWeatherClient,
  setWeatherClient,
  WeatherUnavailableError,
  type Forecast,
  type WeatherClient,
} from "./weather-client";

const MUNICH = { lat: 48.14, lon: 11.58 };

function spot(n: number, kind: string): GeoPoiSearchSpot {
  return {
    osmRef: `way:${n}`,
    type: "way",
    id: n,
    lat: MUNICH.lat + n * 0.0006,
    lon: MUNICH.lon,
    distanceM: n * 70,
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
    .values({ email: `wetter-${stamp}@test.invalid`, name: "Planerin", password_hash: "x" })
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
  geo.setSearchSpots("nom_west", [
    spot(1, "tourism=museum"),
    spot(2, "leisure=park"),
    spot(3, "historic=castle"),
    ...Array.from({ length: 6 }, (_, i) => spot(i + 4, "tourism=attraction")),
  ]);
  setGeoClient(geo);
  weather = new StubClient();
  setWeatherClient(weather);
  return () => {
    resetGeoClient();
    resetWeatherClient();
  };
});

async function trip(startDate = soon()) {
  const { plan } = await createTripPlan({
    legs: [{ title: "München", anchor: MUNICH, startDate }],
  });
  return plan;
}

/** A trip nobody has placed in the year yet (§4.3). */
async function undatedTrip() {
  const { plan } = await createTripPlan({ legs: [{ title: "München", anchor: MUNICH }] });
  return plan;
}

describe("the weather on a day", () => {
  it("summarises each block of the day", async () => {
    weather.precipitationMm = 1;
    const plan = await trip();

    const forecast = await dayForecast({ planId: plan.id, dayIndex: 0, utcOffsetMinutes: 120 });

    expect(forecast.available).toBe(true);
    expect(forecast.blocks.length).toBeGreaterThan(0);
    const withWeather = forecast.blocks.filter((b) => b.weather !== null);
    expect(withWeather.length).toBeGreaterThan(0);
    for (const block of withWeather) {
      expect(block.weather?.wetness).toBe("wet");
    }
  });

  it("shrinks the budget in the wet without touching the plan", async () => {
    // The number the reordering will use, computed and applied nowhere.
    weather.precipitationMm = 3;
    weather.temperatureC = 34;
    const plan = await trip();
    const before = JSON.stringify(plan.legs[0].days);

    const forecast = await dayForecast({ planId: plan.id, dayIndex: 0, utcOffsetMinutes: 120 });

    const wet = forecast.blocks.find((b) => b.weather !== null)!;
    expect(wet.weather!.budgetFactor).toBeLessThan(1);
    expect(wet.weather!.heat).toBe("hot");

    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(JSON.stringify(after.legs[0].days)).toBe(before);
  });

  it("says there is no forecast rather than that it will be fine", async () => {
    // The difference between "we do not know" and "it will be dry" is
    // the whole of §15.3.
    weather.fail = new WeatherUnavailableError("open-meteo answered 503");
    const plan = await trip();

    const forecast = await dayForecast({ planId: plan.id, dayIndex: 0, utcOffsetMinutes: 120 });

    expect(forecast.available).toBe(false);
    expect(forecast.overall).toBeNull();
    for (const block of forecast.blocks) expect(block.weather).toBeNull();
  });

  it("says nothing about a trip that has no dates yet", async () => {
    const plan = await undatedTrip();

    const forecast = await dayForecast({ planId: plan.id, dayIndex: 0 });

    expect(forecast.day).toBeNull();
    expect(forecast.available).toBe(false);
  });

  it("still says which spots mind the wet, dates or no dates", async () => {
    // Shelter is a property of the place, not of the week. It is worth
    // answering for a trip nobody has placed in the year yet.
    const plan = await undatedTrip();

    const forecast = await dayForecast({ planId: plan.id, dayIndex: 0 });

    expect(forecast.spots.length).toBeGreaterThan(0);
    const byRef = new Map(forecast.spots.map((s) => [s.osmRef, s.shelter]));
    if (byRef.has("way:1")) expect(byRef.get("way:1")).toBe("indoor");
    if (byRef.has("way:2")) expect(byRef.get("way:2")).toBe("outdoor");
    if (byRef.has("way:3")) expect(byRef.get("way:3")).toBe("partly");
  });

  it("refuses an offset no clock shows", async () => {
    const plan = await trip();
    await expect(
      dayForecast({ planId: plan.id, dayIndex: 0, utcOffsetMinutes: 7200 }),
    ).rejects.toThrow(/utcOffsetMinutes/);
  });

  it("refuses a day the leg does not have", async () => {
    const plan = await trip();
    await expect(dayForecast({ planId: plan.id, dayIndex: 99 })).rejects.toThrow(/day 99/);
  });
});
