/**
 * The evening before (§8.6).
 *
 * A list over states that already exist — so what is worth pinning
 * down is that each state is read from where it actually lives, and
 * that the two questions this build cannot answer say so instead of
 * showing a green tick that means nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import {
  documents,
  osmRegionImports,
  tripPlanDocuments,
  tripPlans,
  users,
  weatherForecastCache,
} from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import type { ForecastHour } from "./weather";
import {
  resetWeatherClient,
  setWeatherClient,
  type Forecast,
  type WeatherClient,
} from "./weather-client";
import { linkPlanDocument } from "./documents";
import { createTripPlan } from "./plans";
import { tripReadiness } from "./readiness";

const MUNICH = { lat: 48.14, lon: 11.58 };

function spot(n: number, kind: string, category: string): GeoPoiSearchSpot {
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

class StubClient implements WeatherClient {
  precipitationMm = 0;
  temperatureC = 18;

  async forecast(lat: number, lon: number, from: string): Promise<Forecast> {
    const hours: ForecastHour[] = Array.from({ length: 24 }, (_, i) => ({
      time: `${from}T${String(i).padStart(2, "0")}:00:00Z`,
      precipitationMm: this.precipitationMm,
      cloudCover: 70,
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
  await db.delete(tripPlanDocuments);
  await db.delete(tripPlans);
  await db.delete(documents);
  await db.delete(osmRegionImports);
  await db.delete(weatherForecastCache);
  clearRouterCache();
  const stamp = Date.now() + Math.random();
  const [row] = await db
    .insert(users)
    .values({ email: `vorabend-${stamp}@test.invalid`, name: "Planerin", password_hash: "x" })
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
    spot(1, "leisure=park", "outdoors"),
    spot(2, "tourism=viewpoint", "viewpoint"),
    spot(3, "amenity=place_of_worship", "worship"),
    ...Array.from({ length: 6 }, (_, i) => spot(i + 4, "tourism=attraction", "sight")),
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

/**
 * A trip nobody has placed in the year yet (§4.3). Its own helper
 * because passing `startDate: undefined` still lands on a default date.
 */
async function undatedTrip() {
  const { plan } = await createTripPlan({ legs: [{ title: "München", anchor: MUNICH }] });
  return plan;
}

const check = (checks: { id: string; state: string; sentence: string }[], id: string) =>
  checks.find((entry) => entry.id === id)!;

describe("the evening before", () => {
  it("says when the trip starts and that the maps are there", async () => {
    const plan = await trip();

    const readiness = await tripReadiness({ planId: plan.id });

    expect(readiness.startsOn).not.toBeNull();
    expect(check(readiness.checks, "dates").state).toBe("ok");
    expect(check(readiness.checks, "region").state).toBe("ok");
    expect(check(readiness.checks, "detail").state).toBe("ok");
  });

  it("asks for a date when the trip has none", async () => {
    const plan = await undatedTrip();

    const readiness = await tripReadiness({ planId: plan.id });

    expect(readiness.startsOn).toBeNull();
    expect(check(readiness.checks, "dates").state).toBe("attention");
  });

  it("names the leg whose maps are still missing", async () => {
    const plan = await trip();
    // The worst failure §8.6 knows: no pool on the ground, and nothing
    // to be done about it once the group has left.
    await db.delete(osmRegionImports);

    const readiness = await tripReadiness({ planId: plan.id });

    const region = check(readiness.checks, "region");
    expect(region.state).toBe("attention");
    expect(region.sentence).toContain("München");
  });

  it("reports the question it cannot answer as open, not as fine", async () => {
    const plan = await trip();

    const readiness = await tripReadiness({ planId: plan.id });

    expect(check(readiness.checks, "votes").state).toBe("unknown");
  });

  it("does not pretend to know whether a paperless trip is missing paperwork", async () => {
    // The app knows which documents are attached, never which ones this
    // trip needs — a weekend by car needs none (§3.4).
    const plan = await trip();

    const readiness = await tripReadiness({ planId: plan.id });

    expect(check(readiness.checks, "tickets").state).toBe("unknown");
  });

  it("counts the documents that hang on the trip", async () => {
    const plan = await trip();
    const [doc] = await db
      .insert(documents)
      .values({
        user_id: ownerId,
        sha256: `readiness-${Date.now()}-${Math.random()}`,
        original_filename: "buchung.pdf",
        mime_type: "application/pdf",
        size_bytes: 1024,
        disk_path: "/tmp/buchung.pdf",
        status: "ready",
        title: "Hotelbuchung München",
      })
      .returning({ id: documents.id });
    await linkPlanDocument({ planId: plan.id, documentId: doc.id });

    const tickets = check((await tripReadiness({ planId: plan.id })).checks, "tickets");

    expect(tickets.state).toBe("ok");
    expect(tickets.sentence).toContain("Hotelbuchung München");
  });

  it("points at paperwork that looks like this trip's and hangs nowhere", async () => {
    // The evening's cheapest fix: it exists, nobody attached it.
    const plan = await trip();
    await db.insert(documents).values({
      user_id: ownerId,
      sha256: `readiness-loose-${Date.now()}-${Math.random()}`,
      original_filename: "hotel.pdf",
      mime_type: "application/pdf",
      size_bytes: 1024,
      disk_path: "/tmp/hotel.pdf",
      status: "ready",
      title: "Hotelbuchung München",
      summary: "Übernachtung mit Frühstück",
    });

    const tickets = check((await tripReadiness({ planId: plan.id })).checks, "tickets");

    expect(tickets.state).toBe("attention");
  });

  it("leaves the offline bundle to the device", async () => {
    // Only the phone knows what it has stored (§3.9), so the server
    // does not pretend to.
    const plan = await trip();

    const readiness = await tripReadiness({ planId: plan.id });

    expect(readiness.checks.map((entry) => entry.id)).not.toContain("offline");
  });

  it("packs a rain jacket for an open-air day under rain", async () => {
    weather.precipitationMm = 2;
    const plan = await trip();

    const readiness = await tripReadiness({ planId: plan.id });

    expect(readiness.packing.map((item) => item.id)).toContain("rain-jacket");
    expect(readiness.forecastUntil).not.toBeNull();
  });

  it("packs against the heat when the day is hot", async () => {
    weather.temperatureC = 35;
    const plan = await trip();

    const readiness = await tripReadiness({ planId: plan.id });

    expect(readiness.packing.map((item) => item.id))
      .toEqual(expect.arrayContaining(["sun-hat", "water-bottle"]));
  });

  it("packs nothing weather-driven for a trip no forecast reaches", async () => {
    weather.precipitationMm = 5;
    // Half a year out: outside the horizon, so there is no forecast and
    // the list says less rather than inventing one.
    const plan = await trip(soon(180));

    const readiness = await tripReadiness({ planId: plan.id });

    expect(readiness.forecastUntil).toBeNull();
    expect(readiness.packing.map((item) => item.id)).not.toContain("rain-jacket");
  });

  it("keeps the child's spare clothes out of the weather rules", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "München", anchor: MUNICH, startDate: soon() }],
      group: { withChildren: true },
    });

    const readiness = await tripReadiness({ planId: plan.id });

    expect(readiness.packing.map((item) => item.id)).toContain("spare-clothes");
  });

  it("does not hand a trip to somebody who is not on it", async () => {
    const plan = await trip();
    const [stranger] = await db
      .insert(users)
      .values({
        email: `fremd-${Date.now()}@test.invalid`,
        name: "Fremde",
        password_hash: "x",
      })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(stranger.id),
      permissions: ["photos.view"],
    });

    await expect(tripReadiness({ planId: plan.id })).rejects.toThrow(/not found/);
  });
});
