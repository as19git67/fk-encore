/**
 * Where the collection and a trip meet (§20.3).
 *
 * The rule these cases exist for is the one that is easy to get wrong
 * in either direction: an idea taken into a trip is **not spent**. It
 * stays in the collection, because "wir waren da" and "wir wollten da
 * mal hin" are different statements and only the trip knows the first.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { ideaPool, ideaPoolShares, osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { acceptOuting, ideasForPlan, keepForNextTime, takeIdeaIntoPlan } from "./ideas-trip";
import { createTripPlan } from "./plans";

const HOME = { lat: 48.14, lon: 11.58 };
const DB = "nom_west";

function east(metres: number) {
  return {
    lat: HOME.lat,
    lon: HOME.lon + metres / (111_320 * Math.cos((HOME.lat * Math.PI) / 180)),
  };
}

function spot(n: number, at: { lat: number; lon: number }): GeoPoiSearchSpot {
  return {
    osmRef: `node:${800 + n}`,
    type: "node",
    id: 800 + n,
    lat: at.lat,
    lon: at.lon,
    distanceM: 0,
    detourM: null,
    name: `Gefundener Ort ${n}`,
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
    facadeAzimuth: null,
  };
}

let annaId = 0;
let papaId = 0;

async function makeUser(email: string, name: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email, name, password_hash: "x" })
    .returning({ id: users.id });
  return row.id;
}

function actAs(userId: number) {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(userId),
    permissions: ["photos.view"],
  });
}

/**
 * An idea somebody collected, `metres` east of home. Deliberately not
 * on top of an OSM entry, so it goes in as a place the map does not
 * know — the harder of the two cases.
 */
async function idea(metres: number, name: string): Promise<number> {
  const at = east(metres);
  const [row] = await db
    .insert(ideaPool)
    .values({
      owner_id: annaId,
      created_by: papaId,
      osm_ref: `manual:${metres}`,
      name,
      lat: at.lat,
      lon: at.lon,
      category: "sight",
      dwell_minutes: 45,
      note: "Von Papa gemerkt",
      unmatched: true,
    })
    .returning({ id: ideaPool.id });
  return row.id;
}

beforeEach(async () => {
  await db.delete(ideaPoolShares);
  await db.delete(ideaPool);
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = Date.now() + Math.random();
  annaId = await makeUser(`anna-${stamp}@test.invalid`, "Anna");
  papaId = await makeUser(`papa-${stamp}@test.invalid`, "Papa");
  actAs(annaId);

  await db.insert(osmRegionImports).values({
    slug: "europe/west",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: DB,
    bbox_min_lat: 47.9,
    bbox_min_lon: 11.2,
    bbox_max_lat: 48.5,
    bbox_max_lon: 11.9,
    status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots(DB, [spot(1, east(600)), spot(2, east(1_100)), spot(3, east(1_800))]);
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("an accepted outing becomes a trip", () => {
  it("makes a one-day trip out of the accepted ideas", async () => {
    const first = await idea(500, "Papas Biergarten");
    const second = await idea(1_500, "Die Wanderung");

    const accepted = await acceptOuting({
      ...HOME,
      ideaIds: [first, second],
      date: "2026-07-04",
      title: "Samstag",
      mode: "car",
    });

    expect(accepted.plan.title).toBe("Samstag");
    expect(accepted.plan.legs).toHaveLength(1);
    expect(accepted.plan.legs[0].days).toHaveLength(1);
    expect(accepted.plan.legs[0].startDate).toBe("2026-07-04");
    // Both accepted ideas are accounted for, on the day or in the pool.
    expect([...accepted.planned, ...accepted.inPool].sort()).toEqual([first, second].sort());
  });

  it("plans the day out of what was accepted, ahead of what the map offers", async () => {
    const mine = await idea(500, "Papas Biergarten");

    const accepted = await acceptOuting({
      ...HOME, ideaIds: [mine], date: "2026-07-04", mode: "car", budgetMinutes: 120,
    });

    const names = accepted.plan.legs[0].days[0].blocks
      .flatMap((b) => b.stops)
      .map((s) => s.name);
    expect(names).toContain("Papas Biergarten");
  });

  it("leaves the idea in the collection — used, not spent", async () => {
    const mine = await idea(500, "Papas Biergarten");

    await acceptOuting({ ...HOME, ideaIds: [mine], date: "2026-07-04", mode: "car" });

    const rows = await db.select().from(ideaPool).where(eq(ideaPool.id, mine));
    expect(rows).toHaveLength(1);
  });

  it("refuses an outing with nothing in it", async () => {
    await expect(acceptOuting({ ...HOME, ideaIds: [], date: "2026-07-04" }))
      .rejects.toThrow(/ohne Ideen/);
  });

  it("insists on a date, because a day without one is not an outing", async () => {
    const mine = await idea(500, "Papas Biergarten");
    await expect(acceptOuting({ ...HOME, ideaIds: [mine], date: "Samstag" }))
      .rejects.toThrow(/date must be YYYY-MM-DD/);
  });
});

describe("a trip asks about what was collected", () => {
  it("offers the ideas that lie in one of its legs, nearest first", async () => {
    await idea(500, "Papas Biergarten");
    await idea(2_000, "Die Wanderung");
    // Far away: a different holiday's idea has no business here.
    const at = { lat: 52.5, lon: 13.4 };
    await db.insert(ideaPool).values({
      owner_id: annaId, created_by: papaId, osm_ref: "manual:berlin", name: "Weit weg",
      lat: at.lat, lon: at.lon, category: "sight", dwell_minutes: 60,
    });
    const { plan } = await createTripPlan({
      legs: [{ title: "Zuhause", anchor: HOME, startDate: "2026-07-04" }],
    });

    const { ideas } = await ideasForPlan({ planId: plan.id });

    expect(ideas.map((i) => i.name)).toEqual(["Papas Biergarten", "Die Wanderung"]);
    expect(ideas.every((i) => i.alreadyInTrip === false)).toBe(true);
    expect(ideas[0].addedBy).toBe("Papa");
  });

  it("takes nothing over by itself", async () => {
    // §20.3: an idea from last year is not this trip's wish.
    await idea(500, "Papas Biergarten");
    const { plan } = await createTripPlan({
      legs: [{ title: "Zuhause", anchor: HOME, startDate: "2026-07-04" }],
    });

    const { plan: after } = await import("./plans").then((m) =>
      m.getTripPlan({ planId: plan.id }));

    const refs = after.legs[0].pool.map((c) => c.osmRef);
    expect(refs.some((ref) => ref.startsWith("manual:"))).toBe(false);
  });

  it("marks what the trip already has rather than hiding it", async () => {
    const mine = await idea(500, "Papas Biergarten");
    const { plan } = await createTripPlan({
      legs: [{ title: "Zuhause", anchor: HOME, startDate: "2026-07-04" }],
    });
    await takeIdeaIntoPlan({ planId: plan.id, id: mine });

    const { ideas } = await ideasForPlan({ planId: plan.id });

    expect(ideas.find((i) => i.id === mine)?.alreadyInTrip).toBe(true);
  });
});

describe("what the trip did not use", () => {
  it("goes back into the collection for next time", async () => {
    // Framed but not planned, so everything the search found is still
    // in the pool — which is the state this endpoint is for.
    const { plan } = await createTripPlan({
      legs: [{ title: "Zuhause", anchor: HOME, startDate: "2026-07-04" }],
      detailDays: 0,
    });
    const leftover = plan.legs[0].pool[0];
    expect(leftover).toBeDefined();

    const result = await keepForNextTime({ planId: plan.id, osmRefs: [leftover.osmRef] });

    expect(result.kept).toBe(1);
    const rows = await db.select().from(ideaPool).where(eq(ideaPool.osm_ref, leftover.osmRef));
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_id).toBe(annaId);
  });

  it("says so when it was already collected rather than duplicating it", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "Zuhause", anchor: HOME, startDate: "2026-07-04" }],
      detailDays: 0,
    });
    const leftover = plan.legs[0].pool[0];
    await keepForNextTime({ planId: plan.id, osmRefs: [leftover.osmRef] });

    const again = await keepForNextTime({ planId: plan.id, osmRefs: [leftover.osmRef] });

    expect(again).toEqual({ kept: 0, alreadyThere: 1 });
  });

  it("refuses a spot that is not in this trip's pool", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "Zuhause", anchor: HOME, startDate: "2026-07-04" }],
    });

    await expect(keepForNextTime({ planId: plan.id, osmRefs: ["node:999999"] }))
      .rejects.toThrow(/liegt im Vorrat/);
  });
});
