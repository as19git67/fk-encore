/**
 * Trading a rainy day for a drier one (§7.2).
 *
 * The cases that matter are the refusals: a proposal changes nothing,
 * a trip without dates has no days to trade, and a day nobody has a
 * forecast for is never the destination.
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
import { weatherDaySwapApply, weatherDaySwapProposal } from "./weather-day-swap";
import type { ForecastHour } from "./weather";
import {
  resetWeatherClient,
  setWeatherClient,
  type Forecast,
  type WeatherClient,
} from "./weather-client";

const MUNICH = { lat: 48.14, lon: 11.58 };

function spot(n: number): GeoPoiSearchSpot {
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
    kind: n % 2 === 0 ? "leisure=park" : "tourism=museum",
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

/**
 * Rain on the first day of the trip and nothing after — the shape the
 * whole feature exists for.
 */
class FirstDayIsWet implements WeatherClient {
  wetDay: string | null = null;

  async forecast(lat: number, lon: number, from: string, to: string): Promise<Forecast> {
    const hours: ForecastHour[] = [];
    for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`);
         day = new Date(day.getTime() + 86_400_000)) {
      const iso = day.toISOString().slice(0, 10);
      for (let hour = 0; hour < 24; hour += 1) {
        hours.push({
          time: `${iso}T${String(hour).padStart(2, "0")}:00:00Z`,
          precipitationMm: iso === this.wetDay ? 5 : 0,
          cloudCover: 60,
          temperatureC: 18,
          relativeHumidity: 60,
        });
      }
    }
    return { lat, lon, hours };
  }
}

let ownerId = 0;
let weather: FirstDayIsWet;

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
    .values({ email: `tagtausch-${stamp}@test.invalid`, name: "Planerin", password_hash: "x" })
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
  weather = new FirstDayIsWet();
  setWeatherClient(weather);
  return () => {
    resetGeoClient();
    resetWeatherClient();
  };
});

/** Two days planned down to spots, the first of them wet. */
async function wetFirstDay() {
  const startDate = soon();
  weather.wetDay = startDate;
  const { plan } = await createTripPlan({
    legs: [{ title: "München", anchor: MUNICH, days: 2, startDate }],
  });
  return plan;
}

function refs(plan: { legs: { days: { blocks: { stops: { osmRef: string }[] }[] }[] }[] }) {
  return plan.legs[0].days.map((day) =>
    day.blocks.flatMap((block) => block.stops.map((stop) => stop.osmRef)));
}

describe("proposing a whole-day swap", () => {
  it("offers the wet day's spots to the dry one and saves nothing", async () => {
    const plan = await wetFirstDay();
    const before = JSON.stringify(plan.legs[0].days);

    const proposal = await weatherDaySwapProposal({ planId: plan.id, utcOffsetMinutes: 120 });

    expect(proposal.reason).toBe("ok");
    expect(proposal.offered).toBe(true);
    expect(proposal.fromDayIndex).toBe(0);
    expect(proposal.toDayIndex).toBe(1);

    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(JSON.stringify(after.legs[0].days)).toBe(before);
  });

  it("offers nothing when no day is wet", async () => {
    weather.wetDay = null;
    const { plan } = await createTripPlan({
      legs: [{ title: "München", anchor: MUNICH, days: 2, startDate: soon() }],
    });

    const proposal = await weatherDaySwapProposal({ planId: plan.id, utcOffsetMinutes: 120 });

    expect(proposal.offered).toBe(false);
    expect(proposal.reason).toBe("nothing-wet");
  });

  it("refuses a trip that has no dates", async () => {
    const { plan } = await createTripPlan({ legs: [{ title: "München", anchor: MUNICH }] });

    await expect(weatherDaySwapProposal({ planId: plan.id })).rejects.toThrow(/kein Datum/);
  });
});

describe("applying a whole-day swap", () => {
  it("exchanges the two days and keeps their frames", async () => {
    const plan = await wetFirstDay();
    const before = refs(plan);
    const budgets = plan.legs[0].days.map((d) => d.blocks.map((b) => b.budgetMinutes));

    const applied = await weatherDaySwapApply({ planId: plan.id, utcOffsetMinutes: 120 });

    expect(applied.reason).toBe("ok");
    const after = refs(applied.plan);
    expect(after[0]).toEqual(before[1]);
    expect(after[1]).toEqual(before[0]);
    // The hours belong to the date, not to the spots (§4.4).
    expect(applied.plan.legs[0].days.map((d) => d.blocks.map((b) => b.budgetMinutes)))
      .toEqual(budgets);

    const { plan: reloaded } = await getTripPlan({ planId: plan.id });
    expect(refs(reloaded)).toEqual(after);
  });

  it("changes nothing when there is nothing to offer", async () => {
    weather.wetDay = null;
    const { plan } = await createTripPlan({
      legs: [{ title: "München", anchor: MUNICH, days: 2, startDate: soon() }],
    });
    const before = JSON.stringify(plan.legs[0].days);

    const applied = await weatherDaySwapApply({ planId: plan.id, utcOffsetMinutes: 120 });

    expect(applied.reason).toBe("nothing-wet");
    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(JSON.stringify(after.legs[0].days)).toBe(before);
  });
});
