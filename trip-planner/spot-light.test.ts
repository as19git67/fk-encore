/**
 * The light of one spot on the days of its stay (stage 7, step 2):
 * which spots have one, which day is offered, and that accepting puts
 * the spot on that day with a fixed time for the light.
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
import { addFind } from "./add-find";
import { acceptTripSpotLight, startFor, suggestedDay, tripSpotLight, wantsLight, type SpotLightDay } from "./spot-light";
import type { ForecastHour } from "./weather";
import { resetWeatherClient, setWeatherClient, type Forecast, type WeatherClient } from "./weather-client";

const TOWN = { lat: 48.37, lon: 10.9 };
const VIEW = { lat: TOWN.lat + 0.004, lon: TOWN.lon };

function viewpoint(): GeoPoiSearchSpot {
  return {
    osmRef: "node:5", type: "node", id: 5, ...VIEW, distanceM: 5, detourM: null,
    name: "Beispielblick", nameDe: null, nameEn: null, kind: "tourism=viewpoint", categories: ["viewpoint"],
    wikidataQid: null, wikipedia: null, openingHours: null, cuisine: null, wheelchair: null,
    outdoorSeating: null, dietVegetarian: null, dietVegan: null, phone: null, website: null,
    facadeAzimuth: null,
  };
}

/** Overcast on the first day, clear afterwards. */
class CloudyFirstDay implements WeatherClient {
  cloudyDay = "";
  async forecast(lat: number, lon: number, from: string, to: string): Promise<Forecast> {
    const hours: ForecastHour[] = [];
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
      const iso = d.toISOString().slice(0, 10);
      for (let h = 0; h < 24; h += 1) {
        hours.push({
          time: `${iso}T${String(h).padStart(2, "0")}:00:00Z`,
          precipitationMm: 0, cloudCover: iso === this.cloudyDay ? 95 : 10, temperatureC: 15, relativeHumidity: 60,
        });
      }
    }
    return { lat, lon, hours };
  }
}

let weather: CloudyFirstDay;
const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  await db.delete(weatherForecastCache);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `licht-${crypto.randomUUID()}@test.invalid`, name: "Planerin", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "europe/west", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_west",
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.6, status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", [viewpoint()]);
  setGeoClient(geo);
  weather = new CloudyFirstDay();
  setWeatherClient(weather);
  return () => {
    resetGeoClient();
    resetWeatherClient();
  };
});

async function stayWithAView() {
  const startDate = soon(1);
  weather.cloudyDay = startDate;
  const { plan } = await createTripPlan({
    startEmpty: true,
    legs: [{ title: "Musterstadt", anchor: TOWN, days: 3, radiusM: 4_000, startDate }],
  });
  const { entry } = await addFind({ planId: plan.id, ...VIEW });
  return { planId: plan.id, osmRef: entry.osmRef };
}

describe("the light of a spot", () => {
  it("shows the evening on each day and offers a clear one", async () => {
    const { planId, osmRef } = await stayWithAView();
    const light = await tripSpotLight({ planId, legIndex: 0, osmRef });
    expect(light.applies).toBe(true);
    expect(light.days).toHaveLength(3);
    expect(light.days[0].cloudy).toBe(true);
    expect(light.days[0].fromMinutes).toBeGreaterThanOrEqual(14 * 60);
    expect(light.onDayIndex).toBeNull();
    expect(light.suggestedDayIndex).toBe(1);
  });

  it("puts the idea on that day with a fixed time for the light", async () => {
    const { planId, osmRef } = await stayWithAView();
    const light = await tripSpotLight({ planId, legIndex: 0, osmRef });
    await acceptTripSpotLight({ planId, legIndex: 0, osmRef, dayIndex: 1 });
    const plan = (await getTripPlan({ planId })).plan;
    const day = plan.legs[0].days[1];
    expect(day.blocks.flatMap((b) => b.stops.map((s) => s.osmRef))).toContain(osmRef);
    const fix = day.fixpoints.find((f) => f.spotRef === osmRef)!;
    expect(fix.pinReason).toBe("light");
    expect(fix.startMinutes + fix.durationMinutes).toBe(light.days[1].toMinutes);

    // A second evening replaces the first.
    await acceptTripSpotLight({ planId, legIndex: 0, osmRef, dayIndex: 2 });
    const again = (await getTripPlan({ planId })).plan.legs[0];
    expect(again.days.flatMap((d) => d.fixpoints).filter((f) => f.spotRef === osmRef).map((f) => f.pinReason))
      .toEqual(["light"]);
    expect(again.days[2].fixpoints.some((f) => f.spotRef === osmRef)).toBe(true);
    expect((await tripSpotLight({ planId, legIndex: 0, osmRef })).fixedDayIndex).toBe(2);
  });

  it("has nothing for a spot without a view", async () => {
    const { planId } = await stayWithAView();
    const { entry } = await addFind({ planId, lat: TOWN.lat - 0.004, lon: TOWN.lon, name: "Beispielladen", dwellMinutes: 30 });
    const light = await tripSpotLight({ planId, legIndex: 0, osmRef: entry.osmRef });
    expect(light).toMatchObject({ applies: false, days: [], suggestedDayIndex: null });
    await expect(acceptTripSpotLight({ planId, legIndex: 0, osmRef: entry.osmRef, dayIndex: 1 }))
      .rejects.toThrow(/kein Abendlicht/);
  });
});

describe("the rules", () => {
  const day = (dayIndex: number, cloudCover: number | null, past = false): SpotLightDay => ({
    dayIndex, date: "2026-11-25", fromMinutes: 960, toMinutes: 1000, facade: null,
    cloudCover, cloudy: cloudCover !== null && cloudCover >= 75, past,
  });

  it("keeps the day it is on unless that one is cloudy", () => {
    expect(suggestedDay([day(0, 20), day(1, 10)], 0)).toBe(0);
    expect(suggestedDay([day(0, 90), day(1, 40), day(2, 10)], 0)).toBe(2);
    expect(suggestedDay([day(0, 20, true), day(1, null)], null)).toBe(1);
    expect(suggestedDay([day(0, 20, true)], null)).toBeNull();
  });

  it("starts a long visit early so it ends in the light", () => {
    expect(startFor({ fromMinutes: 960, toMinutes: 1000 }, 30)).toBe(960);
    expect(startFor({ fromMinutes: 960, toMinutes: 1000 }, 90)).toBe(910);
  });

  it("asks for photo stops, viewpoints and known facades only", () => {
    expect(wantsLight({ category: "museum" })).toBe(false);
    expect(wantsLight({ category: "museum", facadeAzimuth: 270 })).toBe(true);
    expect(wantsLight({ category: "viewpoint" })).toBe(true);
    expect(wantsLight({ category: "unknown", photoStop: true })).toBe(true);
  });
});
