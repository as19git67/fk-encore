/**
 * Priority and opening hours of an idea (ideas plan, stage 3).
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
import { setIdeaPriority } from "./idea-priority";
import { MANUAL_SCORE } from "./candidates";
import { withIdeaHints, shortDate } from "./idea-hints";
import type { StoredCandidate, StoredDay } from "./plan-store";

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
    .values({ email: `priority-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
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

async function tripWithMuseum(priority?: "must" | "want" | "maybe") {
  // 2026-09-05 is a Saturday: the stay is Saturday, Sunday, Monday.
  const { plan } = await createTripPlan({
    startEmpty: true,
    legs: [{ title: "Musterstadt", anchor: TOWN, days: 3, radiusM: 4_000, startDate: "2026-09-05" }],
  });
  await addFind({ planId: plan.id, ...MUSEUM, name: "Beispielmuseum", priority });
  return (await getTripPlan({ planId: plan.id })).plan;
}

describe("an idea's priority", () => {
  it("is Will unless said, and moves the score", async () => {
    const plain = await tripWithMuseum();
    expect(plain.legs[0].pool[0].priority).toBe("want");
    expect(plain.legs[0].pool[0].score).toBe(MANUAL_SCORE);

    const must = await tripWithMuseum("must");
    expect(must.legs[0].pool[0].priority).toBe("must");
    expect(must.legs[0].pool[0].score).toBe(MANUAL_SCORE + 2);
  });

  it("can be changed on the list and stays with the place on a day and back", async () => {
    const plan = await tripWithMuseum();
    const ref = plan.legs[0].pool[0].osmRef;
    const { plan: lowered } = await setIdeaPriority({ planId: plan.id, legIndex: 0, osmRef: ref, priority: "maybe" });
    expect(lowered.legs[0].pool[0].priority).toBe("maybe");
    expect(lowered.legs[0].pool[0].score).toBe(MANUAL_SCORE - 2);

    const block = lowered.legs[0].days[1].blocks.find((b) => b.kind === "spots")!;
    const { plan: placed } = await placeFromPool({ planId: plan.id, dayIndex: 1, blockId: block.id, osmRef: ref });
    const stop = placed.legs[0].days[1].blocks.flatMap((b) => b.stops).find((s) => s.osmRef === ref)!;
    expect(stop.priority).toBe("maybe");

    const { plan: raised } = await setIdeaPriority({ planId: plan.id, legIndex: 0, osmRef: ref, priority: "must" });
    const raisedStop = raised.legs[0].days[1].blocks.flatMap((b) => b.stops).find((s) => s.osmRef === ref)!;
    expect(raisedStop.priority).toBe("must");

    const { plan: back } = await returnStopToPool({ planId: plan.id, stopId: raisedStop.rowId });
    expect(back.legs[0].pool.find((c) => c.osmRef === ref)?.priority).toBe("must");
  });

  it("refuses what is not a priority and a place that is not there", async () => {
    const plan = await tripWithMuseum();
    await expect(setIdeaPriority({ planId: plan.id, legIndex: 0, osmRef: "node:1", priority: "must" }))
      .rejects.toThrow(/gibt es/);
    await expect(setIdeaPriority({
      planId: plan.id, legIndex: 0, osmRef: plan.legs[0].pool[0].osmRef, priority: "soon" as never,
    })).rejects.toThrow(/priority/);
  });
});

describe("opening hours on an idea", () => {
  it("are taken from the map and say which day of the stay it is closed", async () => {
    const plan = await tripWithMuseum();
    const idea = plan.legs[0].pool[0];
    expect(idea.openingHours).toBe("Tu-Su 10:00-18:00");
    expect(idea.closedOn).toEqual(["2026-09-07"]);

    const block = plan.legs[0].days[2].blocks.find((b) => b.kind === "spots")!;
    const { plan: placed } = await placeFromPool({ planId: plan.id, dayIndex: 2, blockId: block.id, osmRef: idea.osmRef });
    const stop = placed.legs[0].days[2].blocks.flatMap((b) => b.stops)[0];
    expect(stop.openingHours).toBe("Tu-Su 10:00-18:00");
    expect(stop.closedThatDay).toBe(true);
  });
});

describe("the ticket on an idea row", () => {
  it("names the day and hour of a booked visit", () => {
    const day = {
      id: 1, dayIndex: 1, detailed: true, blocks: [],
      fixpoints: [{ spotRef: "node:77", startMinutes: 14 * 60 }],
    } as unknown as StoredDay;
    const idea = { osmRef: "node:77", openingHours: null } as unknown as StoredCandidate;
    const { pool } = withIdeaHints([day], [idea], "2026-09-05");
    expect(pool[0].ticket).toBe("So 6.9. 14:00");
    expect(shortDate("2026-09-07")).toBe("Mo 7.9.");
  });
});
