/**
 * Changing the kind of an idea after the fact.
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
import { addFind } from "./add-find";
import { placeFromPool } from "./pool";
import { returnStopToPool } from "./to-pool";
import { setIdeaCategory } from "./idea-category";

const TOWN = { lat: 48.37, lon: 10.9 };
const MUSEUM = { lat: TOWN.lat + 0.004, lon: TOWN.lon };

function museum(): GeoPoiSearchSpot {
  return {
    osmRef: "node:77", type: "node", id: 77, ...MUSEUM, distanceM: 5, detourM: null,
    name: "Beispielmuseum", nameDe: null, nameEn: null,
    kind: "tourism=museum", categories: ["museum"], wikidataQid: null, wikipedia: null,
    // Closed on Mondays.
    openingHours: "Tu-Su 10:00-18:00", cuisine: null, wheelchair: null, outdoorSeating: null,
    dietVegetarian: null, dietVegan: null, phone: null, website: null, facadeAzimuth: null,
  };
}

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `category-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "europe/west", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_west",
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.6, status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", [museum()]);
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function tripWithMuseum() {
  // 2026-09-05 is a Saturday: the stay is Saturday, Sunday, Monday.
  const { plan } = await createTripPlan({
    startEmpty: true,
    legs: [{ title: "Musterstadt", anchor: TOWN, days: 3, radiusM: 4_000, startDate: "2026-09-05" }],
  });
  await addFind({ planId: plan.id, ...MUSEUM, name: "Beispielmuseum" });
  return (await getTripPlan({ planId: plan.id })).plan;
}

describe("an idea's kind", () => {
  it("can be changed on the list and stays with the place on a day and back", async () => {
    const plan = await tripWithMuseum();
    const ref = plan.legs[0].pool[0].osmRef;
    const dwell = plan.legs[0].pool[0].dwellMinutes;
    const { plan: changed } = await setIdeaCategory({ planId: plan.id, legIndex: 0, osmRef: ref, category: "outdoors" });
    expect(changed.legs[0].pool[0].category).toBe("outdoors");
    // The stay length is its own field and stays.
    expect(changed.legs[0].pool[0].dwellMinutes).toBe(dwell);

    const block = changed.legs[0].days[1].blocks.find((b) => b.kind === "spots")!;
    const { plan: placed } = await placeFromPool({ planId: plan.id, dayIndex: 1, blockId: block.id, osmRef: ref });
    const stop = placed.legs[0].days[1].blocks.flatMap((b) => b.stops).find((s) => s.osmRef === ref)!;
    expect(stop.category).toBe("outdoors");

    const { plan: again } = await setIdeaCategory({ planId: plan.id, legIndex: 0, osmRef: ref, category: "cafe" });
    const againStop = again.legs[0].days[1].blocks.flatMap((b) => b.stops).find((s) => s.osmRef === ref)!;
    expect(againStop.category).toBe("cafe");

    const { plan: back } = await returnStopToPool({ planId: plan.id, stopId: againStop.rowId });
    expect(back.legs[0].pool.find((c) => c.osmRef === ref)?.category).toBe("cafe");
  });

  it("refuses a kind it does not know, a route and a place that is not there", async () => {
    const plan = await tripWithMuseum();
    const ref = plan.legs[0].pool[0].osmRef;
    await expect(setIdeaCategory({ planId: plan.id, legIndex: 0, osmRef: "node:1", category: "museum" }))
      .rejects.toThrow(/gibt es/);
    await expect(setIdeaCategory({ planId: plan.id, legIndex: 0, osmRef: ref, category: "castle" }))
      .rejects.toThrow(/category/);
    await expect(setIdeaCategory({ planId: plan.id, legIndex: 0, osmRef: ref, category: "route" }))
      .rejects.toThrow(/category/);
  });
});
