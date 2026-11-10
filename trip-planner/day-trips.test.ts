/**
 * Day trips as a chip of the spot picker (stage 7, step 3).
 * Coordinates sit in Tuscany; every place is invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoDayTarget } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan } from "./plans";
import { dismissDayTrip } from "./day-trip";
import { acceptTripDayTrip, suggestedTripDay, tripDayTrips } from "./day-trips";

vi.mock("~encore/auth", () => ({ getAuthData: vi.fn() }));

const ANCHOR = { lat: 43.47, lon: 11.04 };
/** About an hour north by car. */
const CITY = { lat: 44.01, lon: 11.04 };
/** A few kilometres away: part of the stay, not a day out. */
const NEAR = { lat: 43.5, lon: 11.04 };

function target(overrides: Partial<GeoDayTarget> = {}): GeoDayTarget {
  return {
    name: "Beispielstadt",
    source: "admin",
    osmRef: "area:900",
    adminLevel: 8,
    at: CITY,
    distanceM: 60_000,
    spotCount: 40,
    linkedCount: 35,
    examples: ["Dom zu Beispielstadt", "Stadtmuseum Beispiel"],
    ...overrides,
  };
}

let geo: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `daytrips-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "italy/centro",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: "nom_centro",
    bbox_min_lat: 42.5,
    bbox_min_lon: 10.0,
    bbox_max_lat: 45.0,
    bbox_max_lon: 12.5,
    status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_centro", []);
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function ideasPlan(days = 4) {
  const { plan } = await createTripPlan({
    startEmpty: true,
    legs: [{ title: "Beispieldorf", anchor: ANCHOR, days, mode: "car" }],
  });
  return plan;
}

describe("GET …/legs/:legIndex/day-trips", () => {
  it("lists the towns an hour away on a trip of ideas, not the ones next door", async () => {
    const p = await ideasPlan();
    geo.setDayTargets("nom_centro", [
      target(),
      target({ name: "Nachbarort Beispiel", osmRef: "area:901", at: NEAR, distanceM: 3_000 }),
      target({ name: "Zweitstadt Beispiel", osmRef: "area:902", spotCount: 30 }),
    ]);

    const res = await tripDayTrips({ planId: p.id, legIndex: 0 });

    expect(res.targets.map((t) => t.name)).toEqual(["Beispielstadt", "Zweitstadt Beispiel"]);
    expect(res.targets[0].travelMinutes).toBeGreaterThanOrEqual(30);
    expect(res.note).toBeNull();
    // Four days: not the first, not the last.
    expect([1, 2]).toContain(res.suggestedDayIndex);
  });

  it("leaves out a place somebody waved away", async () => {
    const p = await ideasPlan();
    geo.setDayTargets("nom_centro", [target()]);
    await dismissDayTrip({ planId: p.id, legIndex: 0, key: "area:900" });

    const res = await tripDayTrips({ planId: p.id, legIndex: 0 });
    expect(res.targets).toEqual([]);
    expect(res.note).not.toBeNull();
  });
});

describe("POST …/day-trips/accept", () => {
  it("makes the day a day out at the destination", async () => {
    const p = await ideasPlan();
    geo.setDayTargets("nom_centro", [target()]);

    await acceptTripDayTrip({ planId: p.id, legIndex: 0, key: "area:900", dayIndex: 2 });

    const { plan } = await getTripPlan({ planId: p.id });
    const day = plan.legs[0].days.find((d) => d.dayIndex === 2);
    expect(day?.anchor?.label).toBe("Beispielstadt");
    expect(day?.anchor?.lat).toBeCloseTo(CITY.lat, 5);
  });

  it("refuses a destination the list does not hold", async () => {
    const p = await ideasPlan();
    geo.setDayTargets("nom_centro", [target()]);
    await expect(acceptTripDayTrip({ planId: p.id, legIndex: 0, key: "area:999", dayIndex: 1 }))
      .rejects.toThrow(/nicht mehr/);
  });
});

describe("suggestedTripDay", () => {
  const day = (dayIndex: number, stops = 0, isDayTrip = false, date: string | null = null) =>
    ({ dayIndex, stops, isDayTrip, date });

  it("takes the emptiest middle day", () => {
    expect(suggestedTripDay([day(0), day(1, 3), day(2, 1), day(3)], null)).toBe(2);
  });

  it("skips a day that is a day trip already and the days that are over", () => {
    const days = [
      day(0, 0, false, "2026-11-01"),
      day(1, 0, false, "2026-11-02"),
      day(2, 0, true, "2026-11-03"),
      day(3, 2, false, "2026-11-04"),
      day(4, 0, false, "2026-11-05"),
    ];
    expect(suggestedTripDay(days, "2026-11-03")).toBe(3);
  });

  it("takes the first or last day of a short stay", () => {
    expect(suggestedTripDay([day(0, 2), day(1, 1)], null)).toBe(1);
  });

  it("says nothing when every day is taken", () => {
    expect(suggestedTripDay([day(0, 0, true)], null)).toBeNull();
  });
});
