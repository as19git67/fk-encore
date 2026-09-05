/**
 * A find into the pool, at the endpoint (§9.2).
 *
 * The five rules of §9.2 exist to stop the pool going to seed, and each
 * of them fails quietly rather than loudly: a find under the wrong leg
 * turns up on the wrong week, a missed duplicate competes with itself,
 * a lost note leaves a spot nobody remembers wanting, and an invented
 * duration has the planner build a day around a number nobody gave it.
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

const WEST = { lat: 48.37, lon: 10.9 };
const EAST = { lat: 48.14, lon: 11.58 };
const TOKYO = { lat: 35.68, lon: 139.69 };

function spot(n: number, at: { lat: number; lon: number }, name?: string): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: at.lat,
    lon: at.lon,
    distanceM: 10,
    detourM: null,
    name: name ?? `Spot ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: null,
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

async function seedRegion(slug: string, postgresDb: string, bbox: [number, number, number, number]) {
  await db.insert(osmRegionImports).values({
    slug,
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: postgresDb,
    bbox_min_lat: bbox[0],
    bbox_min_lon: bbox[1],
    bbox_max_lat: bbox[2],
    bbox_max_lon: bbox[3],
    status: "ready_running",
  });
}

let geo: InMemoryGeoClient;
let ownerId = 0;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `find-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = user.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(ownerId),
    permissions: ["photos.view"],
  });
  await seedRegion("europe/west", "nom_west", [48.2, 10.5, 48.6, 11.2]);
  await seedRegion("europe/east", "nom_east", [48.0, 11.3, 48.4, 11.9]);
  geo = new InMemoryGeoClient();
  setGeoClient(geo);
  return () => resetGeoClient();
});

/** Two legs, both empty of candidates so the pool starts clean. */
async function twoLegPlan() {
  geo.setSearchSpots("nom_west", []);
  geo.setSearchSpots("nom_east", []);
  const { plan } = await createTripPlan({
    legs: [
      { title: "Weststadt", anchor: WEST },
      { title: "Oststadt", anchor: EAST },
    ],
  });
  return plan;
}

const poolOf = (plan: { legs: { pool: { osmRef: string }[] }[] }, leg: number) =>
  plan.legs[leg].pool;

describe("POST /trip-planner/plans/:planId/finds", () => {
  it("files a find by where it is, not by where you are", async () => {
    // A café in the eastern city goes into the eastern leg even while
    // you are standing in the west (§9.2, rule 1).
    const plan = await twoLegPlan();
    const res = await addFind({
      planId: plan.id,
      lat: EAST.lat + 0.001,
      lon: EAST.lon,
      name: "Café Beispielhof",
      dwellMinutes: 30,
    });

    expect(res.legIndex).toBe(1);
    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(poolOf(after, 1).map((c) => c.osmRef)).toHaveLength(1);
    expect(poolOf(after, 0)).toHaveLength(0);
  });

  it("asks rather than guessing when the find is in no leg at all", async () => {
    const plan = await twoLegPlan();
    await expect(
      addFind({ planId: plan.id, ...TOKYO, name: "Weit weg", dwellMinutes: 30 }),
    ).rejects.toThrow(/legIndex mitgeben/);
  });

  it("accepts the leg the caller names after being asked", async () => {
    const plan = await twoLegPlan();
    const res = await addFind({
      planId: plan.id,
      ...TOKYO,
      name: "Weit weg",
      dwellMinutes: 30,
      legIndex: 1,
    });
    expect(res.legIndex).toBe(1);
  });

  it("matches an OSM entry when one is there, and fills in its category", async () => {
    const plan = await twoLegPlan();
    geo.setSearchSpots("nom_west", [spot(1, WEST, "Stadtmuseum Beispielstadt")]);

    const res = await addFind({
      planId: plan.id,
      ...WEST,
      name: "Stadtmuseum Beispielstadt",
    });

    expect(res.matchedOsmRef).toBe("node:1");
    expect(res.entry.category).toBe("museum");
    // The museum default, not a guess: it came from the matched category.
    expect(res.entry.dwellMinutes).toBe(90);
    expect(res.unknown).toEqual([]);
  });

  it("names what it does not know rather than filling it in", async () => {
    // Nothing in OSM here. Opening hours and category are unknown, and
    // the response says so (§9.2, rule 5).
    const plan = await twoLegPlan();
    const res = await addFind({
      planId: plan.id,
      ...WEST,
      name: "Geheimtipp ohne Eintrag",
      dwellMinutes: 45,
    });

    expect(res.matchedOsmRef).toBeNull();
    expect(res.unknown).toEqual(["Öffnungszeiten", "Kategorie"]);
    expect(res.entry.unmatched).toBe(true);
    expect(res.entry.category).toBe("unknown");
    // Its reference says plainly that a person put it there.
    expect(res.entry.osmRef.startsWith("manual:")).toBe(true);
  });

  it("asks for a duration instead of inventing one", async () => {
    // The one question §9.2 has the planner ask. Guessing would have it
    // build a day around a number nobody gave it.
    const plan = await twoLegPlan();
    await expect(
      addFind({ planId: plan.id, ...WEST, name: "Geheimtipp ohne Eintrag" }),
    ).rejects.toThrow(/geschätzte Dauer/);
  });

  it("keeps why it was saved, and where from", async () => {
    // When planning, "beste Pastéis laut Blog" matters more than the
    // name (§9.2, rule 4).
    const plan = await twoLegPlan();
    const res = await addFind({
      planId: plan.id,
      ...WEST,
      name: "Pastelaria Beispiel",
      note: "beste Pastéis laut Blog",
      sourceUrl: "https://beispiel.test/lissabon",
      dwellMinutes: 20,
    });

    expect(res.entry.note).toBe("beste Pastéis laut Blog");
    expect(res.entry.sourceUrl).toBe("https://beispiel.test/lissabon");
    expect(res.entry.addedBy).toBe(ownerId);
    expect(res.entry.reasons).toContain("beste Pastéis laut Blog");
    expect(res.entry.reasons.some((r) => r.includes("beispiel.test"))).toBe(true);
  });

  it("enters as a suggestion, not an appointment", async () => {
    // It competes in the pool like any other candidate; nothing plans
    // it into a day (§9.2, rule 2).
    const plan = await twoLegPlan();
    const res = await addFind({ planId: plan.id, ...WEST, name: "Ein Fund", dwellMinutes: 30 });

    const { plan: after } = await getTripPlan({ planId: plan.id });
    const planned = after.legs[0].days.flatMap((d) =>
      d.blocks.flatMap((b) => b.stops.map((s) => s.osmRef)),
    );
    expect(planned).not.toContain(res.entry.osmRef);
    expect(poolOf(after, 0).map((c) => c.osmRef)).toContain(res.entry.osmRef);
  });

  it("merges a duplicate instead of adding a second entry", async () => {
    const plan = await twoLegPlan();
    await addFind({
      planId: plan.id,
      ...WEST,
      name: "Pastelaria Beispiel",
      note: "beste Pastéis laut Blog",
      dwellMinutes: 20,
    });

    const res = await addFind({
      planId: plan.id,
      lat: WEST.lat + 0.0005,
      lon: WEST.lon,
      name: "Pastelaria Beispiel",
      note: "Anna war da und fand es gut",
      dwellMinutes: 20,
    });

    expect(res.merged).toBe(true);
    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(poolOf(after, 0)).toHaveLength(1);
    // Both reasons survive: two people liking the same café for
    // different reasons is the case worth handling well.
    expect(res.entry.reasons).toContain("beste Pastéis laut Blog");
    expect(res.entry.reasons).toContain("Anna war da und fand es gut");
  });

  it("says so when the place is already planned rather than duplicating it", async () => {
    geo.setSearchSpots("nom_west", [spot(1, WEST, "Stadtmuseum Beispielstadt")]);
    geo.setSearchSpots("nom_east", []);
    const { plan } = await createTripPlan({
      legs: [{ title: "Weststadt", anchor: WEST }],
    });

    await expect(
      addFind({ planId: plan.id, ...WEST, name: "Stadtmuseum Beispielstadt" }),
    ).rejects.toThrow(/schon für diese Etappe eingeplant/);
  });

  it("refuses coordinates that are not coordinates", async () => {
    const plan = await twoLegPlan();
    await expect(
      addFind({ planId: plan.id, lat: 91, lon: 10.9, dwellMinutes: 30 }),
    ).rejects.toThrow(/lat out of range/);
  });

  it("does not write into another user's plan", async () => {
    const plan = await twoLegPlan();
    const [other] = await db
      .insert(users)
      .values({ email: `other-${Date.now()}@test.invalid`, name: "Other", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(other.id),
      permissions: ["photos.view"],
    });

    await expect(
      addFind({ planId: plan.id, ...WEST, name: "Ein Fund", dwellMinutes: 30 }),
    ).rejects.toThrow(/plan not found/);
  });
});
