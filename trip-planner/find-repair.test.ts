/**
 * Finds that took a neighbour's OSM entry get their own back
 * (find-repair.ts), and only on proof.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports, tripPlanFixpoints, tripPlanLegs, tripPlanPool, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan } from "./plans";
import { carriesName, rightfulEntry, tickFindRepair } from "./find-repair";

const TOWN = { lat: 48.37, lon: 10.9 };

function spot(osmRef: string, name: string, at: { lat: number; lon: number }, extra: Partial<GeoPoiSearchSpot> = {}): GeoPoiSearchSpot {
  return {
    osmRef,
    type: "node",
    id: Number(osmRef.split(":")[1]),
    lat: at.lat,
    lon: at.lon,
    distanceM: 10,
    detourM: null,
    name,
    nameDe: null,
    nameEn: null,
    kind: "tourism=attraction",
    categories: ["sight"],
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
    ...extra,
  };
}

const near = { lat: TOWN.lat + 0.0002, lon: TOWN.lon };
const cafe = spot("node:1", "Café am Platz", near, { categories: ["cafe"], kind: "amenity=cafe" });
const church = spot("way:2", "Église Beispielkirche", { lat: near.lat + 0.0002, lon: near.lon }, {
  nameDe: "Beispielkirche",
  openingHours: "Mo-Su 09:00-18:00",
});

describe("which entry a find should have had", () => {
  it("names the entry that carries the find's name when the stored one does not", () => {
    expect(rightfulEntry({ osmRef: "node:1", name: "Beispielkirche" }, [cafe, church], new Set())).toBe(church);
  });

  it("leaves a find alone without proof", () => {
    // The stored entry is the place under another language's name.
    expect(rightfulEntry({ osmRef: "way:2", name: "Beispielkirche" }, [cafe, church], new Set())).toBeNull();
    // No entry carries the name: a name in another language is no proof.
    expect(rightfulEntry({ osmRef: "node:1", name: "Kirche am Markt" }, [cafe, church], new Set())).toBeNull();
    // The stored entry is not nearby: nothing to compare.
    expect(rightfulEntry({ osmRef: "node:9", name: "Beispielkirche" }, [cafe, church], new Set())).toBeNull();
    // The rightful entry is already in the leg.
    expect(rightfulEntry({ osmRef: "node:1", name: "Beispielkirche" }, [cafe, church], new Set(["way:2"]))).toBeNull();
    expect(rightfulEntry({ osmRef: "manual:1-2", name: "Beispielkirche" }, [cafe, church], new Set())).toBeNull();
  });

  it("reads names without accents and case", () => {
    expect(carriesName(church, "beispielkírche")).toBe(true);
    expect(carriesName(cafe, "Beispielkirche")).toBe(false);
  });
});

describe("the repair cron", () => {
  let geo: InMemoryGeoClient;

  beforeEach(async () => {
    await db.delete(tripPlans);
    await db.delete(osmRegionImports);
    clearRouterCache();
    const [user] = await db
      .insert(users)
      .values({ email: `repair-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
    await db.insert(osmRegionImports).values({
      slug: "europe/west",
      geofabrik_url: "https://example.com/x.pbf",
      postgres_db: "nom_west",
      bbox_min_lat: 48.2,
      bbox_min_lon: 10.5,
      bbox_max_lat: 48.6,
      bbox_max_lon: 11.2,
      status: "ready_running",
    });
    geo = new InMemoryGeoClient();
    setGeoClient(geo);
    return () => resetGeoClient();
  });

  async function planWithFind(osmRef: string, name: string) {
    geo.setSearchSpots("nom_west", []);
    const { plan } = await createTripPlan({ legs: [{ title: "Beispielstadt", anchor: TOWN }] });
    const [leg] = await db.select({ id: tripPlanLegs.id }).from(tripPlanLegs).where(eq(tripPlanLegs.plan_id, plan.id));
    await db.insert(tripPlanPool).values({
      leg_id: leg.id, osm_ref: osmRef, name, lat: near.lat, lon: near.lon,
      category: "cafe", dwell_minutes: 45, score: 10, origin: "manual",
    });
    geo.setSearchSpots("nom_west", [cafe, church]);
    return plan;
  }

  it("re-points a find to its own entry, once", async () => {
    const plan = await planWithFind("node:1", "Beispielkirche");

    expect(await tickFindRepair()).toBe(1);

    const { plan: after } = await getTripPlan({ planId: plan.id });
    const idea = after.legs[0].pool[0];
    expect(idea.osmRef).toBe("way:2");
    expect(idea.name).toBe("Beispielkirche");
    expect(idea.category).toBe("sight");
    expect(idea.openingHours).toBe("Mo-Su 09:00-18:00");
    // Looked at once: the next tick leaves it alone.
    const calls = geo.getSearchCalls().length;
    expect(await tickFindRepair()).toBe(0);
    expect(geo.getSearchCalls().length).toBe(calls);
  });

  it("moves a fixed time held by the old reference along", async () => {
    const plan = await planWithFind("node:1", "Beispielkirche");
    const { plan: loaded } = await getTripPlan({ planId: plan.id });
    const dayId = loaded.legs[0].days[0].id;
    await db.insert(tripPlanFixpoints).values({
      day_id: dayId, kind: "appointment", label: "Führung", start_minutes: 600, spot_ref: "node:1",
    });

    await tickFindRepair();

    const [fix] = await db.select({ ref: tripPlanFixpoints.spot_ref }).from(tripPlanFixpoints)
      .where(eq(tripPlanFixpoints.day_id, dayId));
    expect(fix.ref).toBe("way:2");
  });

  it("tries a plan again while its region cannot be asked", async () => {
    const plan = await planWithFind("node:1", "Beispielkirche");
    geo.failSearchFor("nom_west");

    expect(await tickFindRepair()).toBe(0);
    const [row] = await db.select({ c: tripPlans.constraints }).from(tripPlans).where(eq(tripPlans.id, plan.id));
    expect((row.c as Record<string, unknown>).findsRepaired).toBe(1);
  });
});
