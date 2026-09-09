/**
 * Changing the shape of a day (§4.1).
 *
 * Two things are being pinned down here: that a day drawn by hand is
 * planned the way it was drawn, and — the part that was quietly broken
 * — that it is still that day after the next re-plan.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan, updateTripSettings } from "./plans";
import { getTripDayShape, setTripDayShape } from "./day-blocks";
import { inviteToTrip } from "./shares";

const WEST = { lat: 48.37, lon: 10.9 };

function spot(n: number): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: WEST.lat + n * 0.0006,
    lon: WEST.lon,
    distanceM: n * 70,
    detourM: null,
    name: `Museum ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: `Q${n}`,
    wikipedia: `de:Museum ${n}`,
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

let ownerId = 0;
let companionId = 0;
let companionEmail = "";

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

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = Date.now() + Math.random();
  ownerId = await makeUser(`tagesablauf-${stamp}@test.invalid`, "Planerin");
  companionEmail = `mit-${stamp}@test.invalid`;
  companionId = await makeUser(companionEmail, "Mitreisender");
  actAs(ownerId);

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
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", Array.from({ length: 12 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function trip() {
  const { plan } = await createTripPlan({ legs: [{ title: "Weststadt", anchor: WEST }] });
  return plan;
}

function blockIds(plan: Awaited<ReturnType<typeof trip>>) {
  return plan.legs[0].days[0].blocks.map((b) => b.id);
}

/** A day without the sit-down lunch — the example from the issue. */
const NO_LUNCH = [
  { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 210 },
  { id: "afternoon", label: "Nachmittag", kind: "spots", baseBudgetMinutes: 260 },
  { id: "evening", label: "Abend", kind: "spots", baseBudgetMinutes: 120 },
];

describe("the shape of a day", () => {
  it("starts as the default four, and says so", async () => {
    const plan = await trip();

    const shape = await getTripDayShape({ planId: plan.id });

    expect(shape.isDefault).toBe(true);
    expect(shape.blocks.map((b) => b.id)).toEqual(["morning", "midday", "afternoon", "evening"]);
  });

  it("takes the lunch break out when nobody wants one", async () => {
    const plan = await trip();

    const { plan: after } = await setTripDayShape({ planId: plan.id, blocks: NO_LUNCH });

    expect(blockIds(after)).toEqual(["morning", "afternoon", "evening"]);
    expect(after.legs[0].days[0].blocks.find((b) => b.id === "afternoon")?.budgetMinutes)
      .toBe(260);
  });

  it("stays that way through the next re-plan", async () => {
    // The bug behind this: a re-plan built the day from DEFAULT_DAY, so
    // a custom shape reverted the first time somebody changed the pace.
    const plan = await trip();
    await setTripDayShape({ planId: plan.id, blocks: NO_LUNCH });

    await updateTripSettings({ planId: plan.id, pace: "relaxed" });

    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(blockIds(after)).toEqual(["morning", "afternoon", "evening"]);
  });

  it("keeps a day drawn at creation time, too", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "Weststadt", anchor: WEST }],
      blocks: NO_LUNCH,
    });

    await updateTripSettings({ planId: plan.id, pace: "packed" });

    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(blockIds(after)).toEqual(["morning", "afternoon", "evening"]);
  });

  it("renames a block without losing the day", async () => {
    const plan = await trip();

    const { plan: after } = await setTripDayShape({
      planId: plan.id,
      blocks: [
        { id: "morning", label: "Früh raus", kind: "spots", baseBudgetMinutes: 240 },
        { id: "afternoon", label: "Nachmittag", kind: "spots", baseBudgetMinutes: 240 },
      ],
    });

    const blocks = after.legs[0].days[0].blocks;
    expect(blocks.map((b) => b.label)).toEqual(["Früh raus", "Nachmittag"]);
    expect(blocks.some((b) => b.stops.length > 0)).toBe(true);
  });

  it("makes an id for a block that has none", async () => {
    const plan = await trip();

    const { plan: after } = await setTripDayShape({
      planId: plan.id,
      blocks: [
        { label: "Früher Vormittag", kind: "spots", baseBudgetMinutes: 180 },
        { label: "Später Nachmittag", kind: "spots", baseBudgetMinutes: 180 },
      ],
    });

    expect(blockIds(after)).toEqual(["frueher-vormittag", "spaeter-nachmittag"]);
  });

  it("refuses a day nothing can be planned into", async () => {
    // A day of nothing but meal blocks comes back empty with no
    // explanation (§10.3).
    const plan = await trip();

    await expect(setTripDayShape({
      planId: plan.id,
      blocks: [{ id: "midday", label: "Mittag", kind: "meal", baseBudgetMinutes: 90 }],
    })).rejects.toThrow(/mindestens ein Block/);
  });

  it("refuses an empty day, a nameless block and an impossible duration", async () => {
    const plan = await trip();

    await expect(setTripDayShape({ planId: plan.id, blocks: [] }))
      .rejects.toThrow(/mindestens einen Block/);
    await expect(setTripDayShape({
      planId: plan.id,
      blocks: [{ label: "  ", kind: "spots", baseBudgetMinutes: 120 }],
    })).rejects.toThrow(/einen Namen/);
    await expect(setTripDayShape({
      planId: plan.id,
      blocks: [{ label: "Kurz", kind: "spots", baseBudgetMinutes: 5 }],
    })).rejects.toThrow(/Dauer/);
  });

  it("refuses two blocks with the same id", async () => {
    const plan = await trip();

    await expect(setTripDayShape({
      planId: plan.id,
      blocks: [
        { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 180 },
        { id: "morning", label: "Auch Vormittag", kind: "spots", baseBudgetMinutes: 180 },
      ],
    })).rejects.toThrow(/derselben Kennung/);
  });

  it("keeps the day's shape to the organiser", async () => {
    const plan = await trip();
    await inviteToTrip({ planId: plan.id, email: companionEmail });
    actAs(companionId);

    await expect(setTripDayShape({ planId: plan.id, blocks: NO_LUNCH }))
      .rejects.toThrow(/angelegt hat/);
  });
});
