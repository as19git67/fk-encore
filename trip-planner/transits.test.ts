/**
 * A journey between two legs (§22.7): the leg it leaves ends with the
 * departure, the leg it reaches begins with the arrival, and the
 * journey in between is planned along the corridor.
 *
 * Coordinates sit near a river town in Bavaria; every place is invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan } from "./plans";
import { removeTripLeg } from "./legs";
import { addTripTransit } from "./transits";

const ANCHOR = { lat: 48.37, lon: 10.9 };
const NEXT = { lat: 48.37, lon: 11.4 };
const LATER = { lat: 48.37, lon: 11.45 };
const DB = "nom_west";

function spot(n: number, lat: number, lon: number): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat,
    lon,
    distanceM: 400,
    detourM: 800,
    name: `Sehenswürdigkeit ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: "Q1",
    wikipedia: "de:Beispiel",
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

let geo: InMemoryGeoClient;
let ownerId = 0;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `transit-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = user.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(ownerId),
    permissions: ["photos.view"],
  });
  await db.insert(osmRegionImports).values({
    slug: "europe/west",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: DB,
    bbox_min_lat: 48.2,
    bbox_min_lon: 10.5,
    bbox_max_lat: 48.6,
    bbox_max_lon: 11.6,
    status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  geo.setSearchSpots(DB, [
    // Around the first base, around the second, and one on the way.
    spot(1, ANCHOR.lat + 0.003, ANCHOR.lon), spot(2, ANCHOR.lat - 0.003, ANCHOR.lon),
    spot(3, ANCHOR.lat, ANCHOR.lon + 0.25),
    spot(4, NEXT.lat + 0.003, NEXT.lon), spot(5, NEXT.lat - 0.003, NEXT.lon),
  ]);
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function threeLegs() {
  const { plan } = await createTripPlan({
    legs: [
      { title: "Erster Ort", anchor: ANCHOR, anchorLabel: "Hotel am Fluss", days: 2, startDate: "2026-09-05", mode: "car" },
      { title: "Zweiter Ort", anchor: NEXT, anchorLabel: "Pension am See", days: 2, startDate: "2026-09-07", mode: "car" },
      { title: "Dritter Ort", anchor: LATER, days: 1, startDate: "2026-09-10", mode: "car" },
    ],
  });
  return plan;
}

describe("POST /trip-planner/plans/:planId/transits", () => {
  it("puts the journey between two legs and frames both neighbours by it", async () => {
    const plan = await threeLegs();

    const { plan: after } = await addTripTransit({
      planId: plan.id, afterLegIndex: 0,
      departDate: "2026-09-06", departAt: "10:00",
      arriveDate: "2026-09-06", arriveAt: "16:00",
    });

    expect(after.legs.map((l) => [l.position, l.kind, l.title])).toEqual([
      [0, "stay", "Erster Ort"],
      [1, "transit", "Weiterreise nach Zweiter Ort"],
      [2, "stay", "Zweiter Ort"],
      [3, "stay", "Dritter Ort"],
    ]);
    const [left, journey, reached, later] = after.legs;

    // The leg being left ends on the day of departure, with it.
    expect(left.days).toHaveLength(2);
    const departure = left.days[1].fixpoints.find((f) => f.kind === "departure");
    expect(departure).toMatchObject({ startMinutes: 600, label: "Weiterreise nach Zweiter Ort" });

    // The journey: from the one base to the other, on one day.
    expect(journey).toMatchObject({
      startDate: "2026-09-06", departMinutes: 600, endMinutes: 960, mode: "car",
      anchor: NEXT, origin: { lat: ANCHOR.lat, lon: ANCHOR.lon, label: "Hotel am Fluss" },
    });
    expect(journey.days).toHaveLength(1);
    const [block] = journey.days[0].blocks;
    expect(block).toMatchObject({ id: "transit", label: "Unterwegs", budgetMinutes: 360, startMinutes: 600 });
    // Stops go in, in the direction of travel: the day walks from the
    // one base towards the other, not back and forth.
    expect(block.stops.length).toBeGreaterThan(0);
    const lons = block.stops.map((s) => s.lon);
    expect(lons).toEqual([...lons].sort((a, b) => a - b));
    // The place on the way is either planned or waiting in the journey's
    // own pool — the corridor, not a radius around one base.
    const known = [...block.stops.map((s) => s.osmRef), ...journey.pool.map((c) => c.osmRef)];
    expect(known).toContain("node:3");
    expect(journey.days[0].fixpoints.map((f) => f.label))
      .toEqual(["Abfahrt Hotel am Fluss", "Ankunft Pension am See"]);

    // The leg reached begins on the day of arrival, at the arrival —
    // a day earlier than before — and every leg after it moves along.
    expect(reached.startDate).toBe("2026-09-06");
    expect(reached.arriveMinutes).toBe(960);
    expect(later.startDate).toBe("2026-09-09");
  });

  it("frames a journey by train without planning into it", async () => {
    const plan = await threeLegs();
    const { plan: after } = await addTripTransit({
      planId: plan.id, afterLegIndex: 0, mode: "transit",
      departDate: "2026-09-06", departAt: "10:00", arriveDate: "2026-09-06", arriveAt: "16:00",
    });
    const day = after.legs[1].days[0];
    expect(day.detailed).toBe(false);
    expect(day.bufferReason).toBe("Unterwegs mit Bahn oder Bus");
    expect(day.blocks.flatMap((b) => b.stops)).toEqual([]);
  });

  it("refuses what cannot be a journey", async () => {
    const plan = await threeLegs();
    const base = { planId: plan.id, afterLegIndex: 0, departDate: "2026-09-06", arriveDate: "2026-09-06" };
    await expect(addTripTransit({ ...base, departAt: "16:00", arriveAt: "10:00" }))
      .rejects.toMatchObject({ code: "invalid_argument" });
    await expect(addTripTransit({ ...base, afterLegIndex: 2, departAt: "10:00", arriveAt: "16:00" }))
      .rejects.toMatchObject({ code: "failed_precondition" });

    await addTripTransit({ ...base, departAt: "10:00", arriveAt: "16:00" });
    await expect(addTripTransit({ ...base, departAt: "10:00", arriveAt: "16:00" }))
      .rejects.toMatchObject({ code: "failed_precondition" });
  });

  it("needs a trip with dates", async () => {
    const { plan } = await createTripPlan({
      legs: [{ anchor: ANCHOR, days: 1 }, { anchor: NEXT, days: 1 }],
    });
    await expect(addTripTransit({
      planId: plan.id, afterLegIndex: 0,
      departDate: "2026-09-06", departAt: "10:00", arriveDate: "2026-09-06", arriveAt: "16:00",
    })).rejects.toMatchObject({ code: "failed_precondition" });
  });
});

describe("renumbering legs", () => {
  it("survives inserting in front of, and removing from in front of, several legs", async () => {
    const plan = await threeLegs();
    const { plan: withJourney } = await addTripTransit({
      planId: plan.id, afterLegIndex: 0,
      departDate: "2026-09-06", departAt: "10:00", arriveDate: "2026-09-06", arriveAt: "16:00",
    });
    expect(withJourney.legs.map((l) => l.position)).toEqual([0, 1, 2, 3]);

    const { plan: without } = await removeTripLeg({ planId: plan.id, legIndex: 1 });
    expect(without.legs.map((l) => [l.position, l.title]))
      .toEqual([[0, "Erster Ort"], [1, "Zweiter Ort"], [2, "Dritter Ort"]]);
  });
});
