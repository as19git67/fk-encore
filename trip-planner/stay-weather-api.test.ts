/**
 * The weather note of a stay against the database: an outdoor spot on
 * a wet day moves to the dry day when somebody taps, and "Änderungen"
 * takes it back.
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
import { placeFromPool } from "./pool";
import { planJournal, undoPlanOp } from "./plan-ops";
import { applyStayWeatherNote, stayWeatherNotes } from "./stay-weather-api";
import type { ForecastHour } from "./weather";
import { resetWeatherClient, setWeatherClient, type Forecast, type WeatherClient } from "./weather-client";

const TOWN = { lat: 48.37, lon: 10.9 };
const PARK = { lat: TOWN.lat + 0.004, lon: TOWN.lon };
const MUSEUM = { lat: TOWN.lat, lon: TOWN.lon + 0.004 };

function geoSpot(n: number, at: { lat: number; lon: number }, name: string, category: string): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`, type: "node", id: n, ...at, distanceM: 5, detourM: null,
    name, nameDe: null, nameEn: null, kind: null as unknown as string, categories: [category],
    wikidataQid: null, wikipedia: null, openingHours: null, cuisine: null, wheelchair: null,
    outdoorSeating: null, dietVegetarian: null, dietVegan: null, phone: null, website: null,
    facadeAzimuth: null,
  };
}

class OneWetDay implements WeatherClient {
  wetDay = "";
  async forecast(lat: number, lon: number, from: string, to: string): Promise<Forecast> {
    const hours: ForecastHour[] = [];
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
      const iso = d.toISOString().slice(0, 10);
      for (let h = 0; h < 24; h += 1) {
        hours.push({
          time: `${iso}T${String(h).padStart(2, "0")}:00:00Z`,
          precipitationMm: iso === this.wetDay && h >= 8 ? 1 : 0,
          cloudCover: 60, temperatureC: 14, relativeHumidity: 60,
        });
      }
    }
    return { lat, lon, hours };
  }
}

let weather: OneWetDay;
const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  await db.delete(weatherForecastCache);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `regen-${crypto.randomUUID()}@test.invalid`, name: "Planerin", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "europe/west", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_west",
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.6, status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", [
    geoSpot(1, PARK, "Beispielpark", "outdoors"),
    geoSpot(2, MUSEUM, "Beispielmuseum", "museum"),
  ]);
  setGeoClient(geo);
  weather = new OneWetDay();
  setWeatherClient(weather);
  return () => {
    resetGeoClient();
    resetWeatherClient();
  };
});

/** Day 1 wet with the park on it, day 2 dry with the museum. */
async function rainyStay() {
  const startDate = soon(1);
  weather.wetDay = startDate;
  const { plan } = await createTripPlan({
    startEmpty: true,
    legs: [{ title: "Musterstadt", anchor: TOWN, days: 2, radiusM: 4_000, startDate }],
  });
  await addFind({ planId: plan.id, ...PARK });
  await addFind({ planId: plan.id, ...MUSEUM });
  const pool = (await getTripPlan({ planId: plan.id })).plan.legs[0].pool;
  const park = pool.find((p) => p.name === "Beispielpark")!;
  const museum = pool.find((p) => p.name === "Beispielmuseum")!;
  await placeFromPool({ planId: plan.id, dayIndex: 0, osmRef: park.osmRef });
  await placeFromPool({ planId: plan.id, dayIndex: 1, osmRef: museum.osmRef });
  return plan.id;
}

const names = (plan: Awaited<ReturnType<typeof getTripPlan>>["plan"]) =>
  plan.legs[0].days.map((day) => day.blocks.flatMap((b) => b.stops.map((s) => s.name)));

describe("the weather note of a stay", () => {
  it("names the wet day, its outdoor spot and the dry day", async () => {
    const planId = await rainyStay();
    const { notes } = await stayWeatherNotes({ planId, legIndex: 0 });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ dayIndex: 0, wetness: 2, drierDayIndex: 1 });
    expect(notes[0].outdoor.map((s) => s.name)).toEqual(["Beispielpark"]);
    expect(notes[0].swap?.gets.map((s) => s.name)).toEqual(["Beispielmuseum"]);
  });

  it("swaps the days, and the undo puts them back", async () => {
    const planId = await rainyStay();
    const { plan, sentence, opId } = await applyStayWeatherNote({ planId, legIndex: 0, dayIndex: 0, kind: "swap" });
    expect(names(plan)).toEqual([["Beispielmuseum"], ["Beispielpark"]]);
    expect(sentence).toMatch(/getauscht/);
    const journal = await planJournal({ planId });
    expect(journal.entries[0]).toMatchObject({ id: opId, sentence, undoable: true });

    await undoPlanOp({ planId, opId });
    expect(names((await getTripPlan({ planId })).plan)).toEqual([["Beispielpark"], ["Beispielmuseum"]]);
    expect((await stayWeatherNotes({ planId, legIndex: 0 })).notes).toHaveLength(1);
  });

  it("moves only the outdoor spot, and refuses an offer that no longer stands", async () => {
    const planId = await rainyStay();
    const { plan } = await applyStayWeatherNote({ planId, legIndex: 0, dayIndex: 0, kind: "outdoor" });
    expect(names(plan)).toEqual([[], ["Beispielmuseum", "Beispielpark"]]);
    await expect(applyStayWeatherNote({ planId, legIndex: 0, dayIndex: 0, kind: "outdoor" }))
      .rejects.toThrow(/nicht mehr/);
    await expect(applyStayWeatherNote({ planId, legIndex: 0, dayIndex: 0, kind: "rain" }))
      .rejects.toThrow(/kind/);
  });
});
