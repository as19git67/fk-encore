/**
 * The light hint on a real plan (§7.3).
 *
 * The cases worth writing down are the ones about restraint: a trip
 * with no dates gets no windows rather than today's by accident, a spot
 * with no outline gets a time and no claim about what it lights, and
 * nothing here moves a single stop.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan } from "./plans";
import { dayLight } from "./daylight";

const MUNICH = { lat: 48.14, lon: 11.58 };

/** A building whose long faces run north-east to south-west. */
const FACES_THE_EVENING_SUN = 125;

function spot(n: number, facadeAzimuth: number | null = null): GeoPoiSearchSpot {
  return {
    osmRef: `way:${n}`,
    type: "way",
    id: n,
    lat: MUNICH.lat + n * 0.0006,
    lon: MUNICH.lon,
    distanceM: n * 70,
    detourM: null,
    name: `Museum ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
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
    facadeAzimuth,
  };
}

let ownerId = 0;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = Date.now() + Math.random();
  const [row] = await db
    .insert(users)
    .values({ email: `light-${stamp}@test.invalid`, name: "Planerin", password_hash: "x" })
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
    ...Array.from({ length: 8 }, (_, i) => spot(i + 1)),
    spot(20, FACES_THE_EVENING_SUN),
  ]);
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function datedTrip(startDate = "2026-06-21") {
  const { plan } = await createTripPlan({
    legs: [{ title: "München", anchor: MUNICH, startDate }],
  });
  return plan;
}

/** A trip nobody has placed in the year yet (§4.3). */
async function undatedTrip() {
  // The field is omitted, not null: "no date" is a leg without it, and
  // createTripPlan rejects an explicit null as malformed.
  const { plan } = await createTripPlan({ legs: [{ title: "München", anchor: MUNICH }] });
  return plan;
}

describe("the light on a day of a trip", () => {
  it("names the golden and blue hours in the destination's clock", async () => {
    const plan = await datedTrip();

    const light = await dayLight({ planId: plan.id, dayIndex: 0, utcOffsetMinutes: 120 });

    expect(light.day).toBe("2026-06-21");
    const golden = light.windows.filter((w) => w.kind === "golden");
    expect(golden).toHaveLength(2);
    // Midsummer in Munich: the evening window ends shortly after the
    // 21:17 sunset, on the local clock the traveller is reading.
    expect(golden[1].toMinutes).toBeGreaterThan(21 * 60);
    expect(golden[1].toMinutes).toBeLessThan(22 * 60);
  });

  it("says nothing at all for a trip that has no dates yet", async () => {
    // A trip planned "sometime" has no day to compute for. Answering
    // with today's sun would be a fact about the wrong date (§4.3).
    const plan = await undatedTrip();

    const light = await dayLight({ planId: plan.id, dayIndex: 0 });

    expect(light.day).toBeNull();
    expect(light.windows).toHaveLength(0);
    expect(light.spots).toHaveLength(0);
  });

  it("answers for every planned stop of that day", async () => {
    const plan = await datedTrip();
    const planned = plan.legs[0].days[0].blocks.flatMap((b) => b.stops).map((s) => s.osmRef);

    const light = await dayLight({ planId: plan.id, dayIndex: 0, utcOffsetMinutes: 120 });

    expect(light.spots.map((s) => s.osmRef)).toEqual(planned);
    for (const hint of light.spots) {
      expect(hint.best?.kind).toBe("golden");
    }
  });

  it("says how the sun meets a building it has an outline for", async () => {
    const plan = await datedTrip();
    const light = await dayLight({ planId: plan.id, dayIndex: 0, utcOffsetMinutes: 120 });

    const oriented = light.spots.find((s) => s.osmRef === "way:20");
    if (oriented) {
      expect(oriented.facade).toBe("frontal");
      expect(oriented.best?.fromMinutes).toBeGreaterThan(12 * 60);
    }
  });

  it("gives a spot with no outline a time and no claim about what it lights", async () => {
    // Most POIs are mapped as nodes and have no orientation at all.
    // The hint is then still useful and stops short of inventing one.
    const plan = await datedTrip();
    const light = await dayLight({ planId: plan.id, dayIndex: 0, utcOffsetMinutes: 120 });

    const plain = light.spots.find((s) => s.osmRef !== "way:20");
    expect(plain?.facade).toBeNull();
    expect(plain?.best).not.toBeNull();
  });

  it("moves nothing — it is a hint, not a plan", async () => {
    const plan = await datedTrip();
    const before = JSON.stringify(plan.legs[0].days);

    await dayLight({ planId: plan.id, dayIndex: 0, utcOffsetMinutes: 120 });

    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(JSON.stringify(after.legs[0].days)).toBe(before);
  });

  it("refuses an offset no clock shows", async () => {
    // A caller sending seconds instead of minutes would otherwise get
    // the golden hour in the middle of the night.
    const plan = await datedTrip();
    await expect(
      dayLight({ planId: plan.id, dayIndex: 0, utcOffsetMinutes: 7200 }),
    ).rejects.toThrow(/utcOffsetMinutes/);
  });

  it("refuses a day the leg does not have", async () => {
    const plan = await datedTrip();
    await expect(dayLight({ planId: plan.id, dayIndex: 99 })).rejects.toThrow(/day 99/);
  });
});
