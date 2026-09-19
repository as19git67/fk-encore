/**
 * The suggestion that nobody asked for, and the many times it must
 * not be made (§4.6).
 *
 * Coordinates sit in Tuscany; every place is invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoDayTarget, GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan } from "./plans";
import { setTripDayAnchor } from "./day-anchor-edit";
import { acceptDayTrip, dayTripSuggestion, dismissDayTrip } from "./day-trip";

vi.mock("~encore/auth", () => ({ getAuthData: vi.fn() }));

/** The small town the trip is booked in. */
const ANCHOR = { lat: 43.47, lon: 11.04 };

/** Sixty kilometres north: the city everybody says you must see. */
const CITY = { lat: 44.01, lon: 11.04 };

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
    examples: ["Dom zu Beispielstadt", "Stadtmuseum Beispiel", "Galerie am Markt"],
    ...overrides,
  };
}

/** A spot the pool would rate as worth a block. */
function spot(id: number, at: { lat: number; lon: number }, name: string): GeoPoiSearchSpot {
  return {
    osmRef: `node:${id}`,
    type: "node",
    id,
    lat: at.lat,
    lon: at.lon,
    distanceM: 400,
    detourM: null,
    name,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: `Q${id}`,
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

/** Enough nearby sights that two days are carried comfortably. */
function richTown(): GeoPoiSearchSpot[] {
  return Array.from({ length: 30 }, (_, index) =>
    spot(index + 1, { lat: ANCHOR.lat + index * 0.001, lon: ANCHOR.lon + index * 0.001 },
         `Sehenswürdigkeit ${index + 1}`));
}

let geo: InMemoryGeoClient;
let ownerId = 0;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `daytrip-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = user.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(ownerId),
    permissions: ["photos.view"],
  });
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
  // An empty search: the leg is planned with nothing in its pool,
  // which is exactly the undersupplied case §4.6 is about.
  geo.setSearchSpots("nom_centro", []);
  setGeoClient(geo);
  return () => resetGeoClient();
});

/** A leg of four days by car, with nothing the region could offer. */
async function thinPlan(days = 4) {
  const { plan } = await createTripPlan({
    legs: [{ title: "Beispieldorf", anchor: ANCHOR, days, mode: "car" }],
  });
  return plan;
}

describe("GET /trip-planner/plans/:planId/day-trip", () => {
  it("offers the city when the pool does not carry the days", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [target()]);

    const res = await dayTripSuggestion({ planId: p.id });

    expect(res.undersupplied).toBe(true);
    expect(res.suggestion?.target.name).toBe("Beispielstadt");
    expect(res.suggestion?.target.spotCount).toBe(40);
    expect(res.note).toBeNull();
  });

  it("says why it is asking, what is there and what it costs", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [target()]);

    const sentence = (await dayTripSuggestion({ planId: p.id })).suggestion?.sentence ?? "";

    // §4.6 names all three deliberately.
    expect(sentence).toMatch(/tragen die Vorschläge/);
    expect(sentence).toMatch(/Beispielstadt/);
    expect(sentence).toMatch(/Fahrt/);
    expect(sentence).toMatch(/\?$/);
  });

  it("names the day it would be — an empty one", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [target()]);
    const res = await dayTripSuggestion({ planId: p.id });
    expect(res.suggestion?.dayIndex).toBeGreaterThanOrEqual(0);
    expect(res.suggestion?.dayIndex).toBeLessThan(4);
  });

  it("charges the way there and back to that day", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [target()]);
    const res = await dayTripSuggestion({ planId: p.id });
    const suggestion = res.suggestion;
    expect(suggestion).not.toBeNull();
    expect(suggestion!.target.travelMinutes).toBeGreaterThan(0);
    expect(suggestion!.target.dayAtTargetMinutes)
      .toBe(res.dayMinutes - 2 * suggestion!.target.travelMinutes);
  });

  it("offers one destination, not a list", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [
      target(),
      target({ name: "Zweitstadt Beispiel", osmRef: "area:901", spotCount: 30 }),
    ]);
    const res = await dayTripSuggestion({ planId: p.id });
    // An evening carries one outing; five are a decision (§20.2).
    expect(res.suggestion?.target.name).toBe("Beispielstadt");
    expect(Object.keys(res)).not.toContain("suggestions");
  });

  it("writes nothing — the plan is unchanged afterwards", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [target()]);
    await dayTripSuggestion({ planId: p.id });

    const { getTripPlan } = await import("./plans");
    const { plan: after } = await getTripPlan({ planId: p.id });
    // The planner invents no appointments (§7.1): accepting is a
    // separate call a person makes.
    expect(after.legs[0].days.every((day) => day.anchor === null || day.anchor === undefined))
      .toBe(true);
  });
});

describe("when it must keep quiet", () => {
  it("says nothing about a leg whose own pool carries its days", async () => {
    // Thirty sights on the doorstep: whatever is an hour away, this
    // leg is not short of anything (§4.6 — no outing as a gap filler).
    geo.setSearchSpots("nom_centro", richTown());
    const { plan } = await createTripPlan({
      legs: [{ title: "Beispielstadt", anchor: ANCHOR, days: 2, mode: "car" }],
    });
    geo.setDayTargets("nom_centro", [target()]);

    const res = await dayTripSuggestion({ planId: plan.id });
    expect(res.undersupplied).toBe(false);
    expect(res.suggestion).toBeNull();
  });

  it("leaves a one-day leg alone", async () => {
    const p = await thinPlan(1);
    geo.setDayTargets("nom_centro", [target()]);
    const res = await dayTripSuggestion({ planId: p.id });
    // There is nothing to go instead of (§4.6).
    expect(res.undersupplied).toBe(false);
    expect(res.suggestion).toBeNull();
  });

  it("refuses a destination that holds too little for a day", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [target({ name: "Kleinsthausen", spotCount: 2 })]);
    const res = await dayTripSuggestion({ planId: p.id });
    expect(res.suggestion).toBeNull();
    expect(res.note).toMatch(/einen ganzen Tag/);
  });

  it("refuses a destination too far to leave a day there", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [
      // Far enough that both ways eat the day.
      target({ name: "Fernstadt Beispiel", at: { lat: 44.9, lon: 11.04 }, distanceM: 160_000 }),
    ]);
    const res = await dayTripSuggestion({ planId: p.id });
    expect(res.suggestion).toBeNull();
  });

  it("does not count a day that already goes somewhere else", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [target()]);
    // Send every day away: nothing is left for the base to carry.
    for (const dayIndex of [0, 1, 2, 3]) {
      await setTripDayAnchor({
        planId: p.id,
        dayIndex,
        lat: CITY.lat,
        lon: CITY.lon,
        label: "Beispielstadt",
      });
    }
    const res = await dayTripSuggestion({ planId: p.id });
    expect(res.undersupplied).toBe(false);
    expect(res.suggestion).toBeNull();
  });

  it("says plainly when no region has been imported for this city", async () => {
    // Planned while the region was there, asked after it went: the
    // trip outlives its region, and a leg awaiting an import is the
    // ordinary way into this (§4.3).
    const p = await thinPlan();
    await db.delete(osmRegionImports);
    clearRouterCache();
    const res = await dayTripSuggestion({ planId: p.id });
    expect(res.suggestion).toBeNull();
    expect(res.note).toMatch(/keine Region importiert/);
  });

  it("says when nothing is in reach at all", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", []);
    const res = await dayTripSuggestion({ planId: p.id });
    expect(res.suggestion).toBeNull();
    expect(res.note).toMatch(/erreichbarer Entfernung/);
  });
});

describe("the frame around it", () => {
  it("refuses a plan that is not yours", async () => {
    const p = await thinPlan();
    const [other] = await db
      .insert(users)
      .values({ email: `other-${Date.now()}@test.invalid`, name: "Other", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(other.id),
      permissions: ["photos.view"],
    });
    await expect(dayTripSuggestion({ planId: p.id })).rejects.toThrow(/plan not found/);
  });

  it("refuses a leg this trip does not have", async () => {
    const p = await thinPlan();
    await expect(dayTripSuggestion({ planId: p.id, legIndex: 7 })).rejects.toThrow(/leg 7/);
  });
});

describe("accepting it", () => {
  it("turns the suggestion into that day's trip", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [target()]);
    const before = await dayTripSuggestion({ planId: p.id });
    const key = before.suggestion!.target.key;
    const dayIndex = before.suggestion!.dayIndex;

    const after = await acceptDayTrip({ planId: p.id, key });

    const day = after.plan.legs[0].days.find((d) => d.dayIndex === dayIndex);
    expect(day?.anchor?.label).toBe("Beispielstadt");
    expect(day?.anchor?.lat).toBeCloseTo(CITY.lat, 4);
  });

  it("puts it on the day somebody picked, when they picked one", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [target()]);
    const key = (await dayTripSuggestion({ planId: p.id })).suggestion!.target.key;

    const after = await acceptDayTrip({ planId: p.id, key, dayIndex: 3 });

    expect(after.plan.legs[0].days.find((d) => d.dayIndex === 3)?.anchor?.label)
      .toBe("Beispielstadt");
  });

  it("refuses a suggestion that no longer stands", async () => {
    // Where a day happens is not something a request may state, so the
    // destination is looked up again — and if it is gone, so is the
    // acceptance (§4.5).
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [target()]);
    await expect(acceptDayTrip({ planId: p.id, key: "area:999" }))
      .rejects.toThrow(/gilt nicht mehr/);
  });

  it("refuses a day this leg does not have", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [target()]);
    const key = (await dayTripSuggestion({ planId: p.id })).suggestion!.target.key;
    await expect(acceptDayTrip({ planId: p.id, key, dayIndex: 9 }))
      .rejects.toThrow(/day 9/);
  });
});

describe("waving it away", () => {
  it("does not come back with the same place", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [target()]);
    const key = (await dayTripSuggestion({ planId: p.id })).suggestion!.target.key;

    await dismissDayTrip({ planId: p.id, key, name: "Beispielstadt" });

    const again = await dayTripSuggestion({ planId: p.id });
    expect(again.suggestion).toBeNull();
    // Still undersupplied — the leg did not get better, the planner
    // just stopped asking (§6.4).
    expect(again.undersupplied).toBe(true);
  });

  it("offers the next place instead of going quiet altogether", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [
      target(),
      target({ name: "Zweitstadt Beispiel", osmRef: "area:901", spotCount: 30 }),
    ]);
    const key = (await dayTripSuggestion({ planId: p.id })).suggestion!.target.key;

    await dismissDayTrip({ planId: p.id, key });

    expect((await dayTripSuggestion({ planId: p.id })).suggestion?.target.name)
      .toBe("Zweitstadt Beispiel");
  });

  it("takes the same no twice without piling up", async () => {
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [target()]);
    const key = (await dayTripSuggestion({ planId: p.id })).suggestion!.target.key;

    await dismissDayTrip({ planId: p.id, key });
    const second = await dismissDayTrip({ planId: p.id, key });
    expect(second.dismissed).toBe(true);
  });

  it("names a place with no boundary by where it is", async () => {
    // A cluster has no OSM reference to remember it by, so the key is
    // its rounded position — and it has to survive a re-plan.
    const p = await thinPlan();
    geo.setDayTargets("nom_centro", [
      target({ name: "Beispieltal", source: "cluster", osmRef: null }),
    ]);
    const key = (await dayTripSuggestion({ planId: p.id })).suggestion!.target.key;
    expect(key).toMatch(/^at:/);

    await dismissDayTrip({ planId: p.id, key });
    expect((await dayTripSuggestion({ planId: p.id })).suggestion).toBeNull();
  });
});
