/**
 * "Tag füllen" against the database (stage 8, step 2): a proposal
 * writes nothing, the weather keeps the park off the wet day,
 * "Übernehmen" writes soft stops and a journal entry that takes them
 * off again.
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
import { planJournal, undoPlanOp } from "./plan-ops";
import { acceptTripFill, FILL_DAY_OP, fillTripDay, fillTripStay } from "./open-fill-api";
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
    .values({ email: `fuellen-${crypto.randomUUID()}@test.invalid`, name: "Planerin", password_hash: "x" })
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

/** Two days from tomorrow, the park and the museum both still open. */
async function stay() {
  const startDate = soon(1);
  const { plan } = await createTripPlan({
    startEmpty: true,
    legs: [{ title: "Musterstadt", anchor: TOWN, days: 2, radiusM: 4_000, startDate }],
  });
  await addFind({ planId: plan.id, ...PARK });
  await addFind({ planId: plan.id, ...MUSEUM });
  const pool = (await getTripPlan({ planId: plan.id })).plan.legs[0].pool;
  const ref = (name: string) => pool.find((p) => p.name === name)!.osmRef;
  return { planId: plan.id, startDate, park: ref("Beispielpark"), museum: ref("Beispielmuseum") };
}

describe("Tag füllen", () => {
  it("proposes the open spots for a day and writes nothing", async () => {
    const { planId, park, museum } = await stay();
    const { proposal } = await fillTripDay({ planId, legIndex: 0, dayIndex: 0 });
    expect(proposal.picks.map((p) => p.osmRef).sort()).toEqual([museum, park].sort());
    expect(proposal.line.every((l) => l.proposed && l.etaMinutes !== null)).toBe(true);
    expect(proposal.overrunMinutes).toBe(0);

    const { plan } = await getTripPlan({ planId });
    expect(plan.legs[0].pool).toHaveLength(2);
    expect(plan.legs[0].days[0].blocks.flatMap((b) => b.stops)).toHaveLength(0);
  });

  it("keeps the park off the wet day when the next one is dry", async () => {
    const { planId, startDate, park, museum } = await stay();
    weather.wetDay = startDate;
    const { proposal } = await fillTripDay({ planId, legIndex: 0, dayIndex: 0 });
    expect(proposal.picks.map((p) => p.osmRef)).toEqual([museum]);
    expect(proposal.picks[0].reasons).toContain("drinnen, falls es regnet");

    const { proposals } = await fillTripStay({ planId, legIndex: 0 });
    expect(proposals.map((p) => p.picks.map((pick) => pick.osmRef))).toEqual([[museum], [park]]);
  });

  it("writes soft stops on Übernehmen, and Änderungen takes them off again", async () => {
    const { planId, park, museum } = await stay();
    const { sentence, opId, plan } = await acceptTripFill({
      planId, legIndex: 0, days: [{ dayIndex: 0, osmRefs: [museum] }, { dayIndex: 1, osmRefs: [park] }],
    });
    expect(sentence).toBe("2 Tage gefüllt: 2 Spots");
    const days = plan.legs[0].days.map((d) => d.blocks.flatMap((b) => b.stops).map((s) => [s.osmRef, s.placedBy]));
    expect(days).toEqual([[[museum, "fill"]], [[park, "fill"]]]);
    expect(plan.legs[0].pool).toHaveLength(0);

    const { entries } = await planJournal({ planId });
    const entry = entries.find((e) => e.id === opId)!;
    expect(entry.kind).toBe(FILL_DAY_OP);
    expect(entry.undoable).toBe(true);

    await undoPlanOp({ planId, opId });
    const after = (await getTripPlan({ planId })).plan.legs[0];
    expect(after.days.flatMap((d) => d.blocks.flatMap((b) => b.stops))).toHaveLength(0);
    expect(after.pool.map((p) => p.osmRef).sort()).toEqual([museum, park].sort());
  });

  it("names one day in the sentence and refuses what is no longer open", async () => {
    const { planId, museum } = await stay();
    const { sentence } = await acceptTripFill({ planId, legIndex: 0, days: [{ dayIndex: 0, osmRefs: [museum] }] });
    expect(sentence).toMatch(/gefüllt: Beispielmuseum$/);
    await expect(acceptTripFill({ planId, legIndex: 0, days: [{ dayIndex: 1, osmRefs: [museum] }] }))
      .rejects.toThrow("nicht mehr offen");
  });
});
