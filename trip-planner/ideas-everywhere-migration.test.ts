/**
 * Migration 0304: every trip becomes a trip of ideas
 * (reise-planen-und-unterwegs.md, stage 1).
 *
 * A trip built the old way — a searched pool, planned days, a vote —
 * reads afterwards like a trip of ideas with the same days and stops:
 * the searched candidates, routes and votes are gone, every find stays.
 */

import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports, tripLegCuration, tripPlans, tripPlanVotes, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan } from "./plans";
import { addFind } from "./add-find";
import { isIdeasTrip, votingOn } from "./ideas-mode";

const TOWN = { lat: 48.37, lon: 10.9 };

function spot(n: number, lat: number, lon: number): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`, type: "node", id: n, lat, lon, distanceM: 10, detourM: null,
    name: `Beispielplatz ${n}`, nameDe: null, nameEn: null,
    kind: "tourism=museum", categories: ["museum"], wikidataQid: "Q1", wikipedia: "de:Beispiel",
    openingHours: null, cuisine: null, wheelchair: null, outdoorSeating: null,
    dietVegetarian: null, dietVegan: null, phone: null, website: null, facadeAzimuth: null,
  };
}

let userId: number;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `migrate-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  userId = user.id;
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "europe/west", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_west",
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.6, status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", Array.from({ length: 12 }, (_, i) => spot(i + 1, TOWN.lat + (i + 1) * 0.001, TOWN.lon)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function runMigration() {
  const file = path.join(process.cwd(), "db/migrations/postgres/0304_trip_ideas_everywhere.sql");
  const statements = fs.readFileSync(file, "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  for (const statement of statements) await db.execute(sql.raw(statement));
}

const stopsOf = (leg: { days: { blocks: { stops: { name: string | null }[] }[] }[] }) =>
  leg.days.map((d) => d.blocks.flatMap((b) => b.stops.map((s) => s.name)));

describe("migration 0304_trip_ideas_everywhere", () => {
  it("turns a searched trip into a trip of ideas with the same days and stops", async () => {
    const { plan: old } = await createTripPlan({
      startEmpty: false,
      legs: [{ title: "Musterstadt", anchor: TOWN, days: 2, radiusM: 4_000, startDate: "2026-09-05" }],
    });
    expect(isIdeasTrip(old.constraints)).toBe(false);
    await addFind({ planId: old.id, lat: TOWN.lat - 0.02, lon: TOWN.lon + 0.02, name: "Eigener Fund", dwellMinutes: 30 });
    const { plan: before } = await getTripPlan({ planId: old.id });
    const leg = before.legs[0];
    expect(leg.pool.some((c) => c.origin === "search")).toBe(true);
    await db.insert(tripPlanVotes).values({ leg_id: leg.id, osm_ref: leg.pool[0].osmRef, user_id: userId, value: "yes" });
    await db.insert(tripLegCuration).values({ leg_id: leg.id }).onConflictDoNothing();

    await runMigration();

    const { plan: after } = await getTripPlan({ planId: old.id });
    expect(isIdeasTrip(after.constraints)).toBe(true);
    expect(votingOn(after.constraints)).toBe(false);
    expect(after.legs[0].days).toHaveLength(2);
    expect(stopsOf(after.legs[0])).toEqual(stopsOf(leg));
    expect(after.legs[0].pool.map((c) => c.name)).toEqual(["Eigener Fund"]);
    expect(await db.select().from(tripPlanVotes).where(eq(tripPlanVotes.leg_id, leg.id))).toEqual([]);
    expect(await db.select().from(tripLegCuration).where(eq(tripLegCuration.leg_id, leg.id))).toEqual([]);
  });

  it("leaves a trip of ideas as it is", async () => {
    const { plan } = await createTripPlan({
      startEmpty: true,
      legs: [{ title: "Musterstadt", anchor: TOWN, days: 1, radiusM: 4_000, startDate: "2026-09-05" }],
    });
    await addFind({ planId: plan.id, lat: TOWN.lat - 0.02, lon: TOWN.lon + 0.02, name: "Eigener Fund", dwellMinutes: 30 });
    await runMigration();
    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(after.constraints).toMatchObject({ ideas: true });
    expect(after.legs[0].pool.map((c) => c.name)).toEqual(["Eigener Fund"]);
  });
});
