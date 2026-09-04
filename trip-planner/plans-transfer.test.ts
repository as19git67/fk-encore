/**
 * Transfer days: the move between two legs (§4.2).
 *
 * A transfer is not dead time, it is a fixpoint that eats half a day at
 * each end — the day you leave has no evening, the day you arrive has
 * no morning. What these tests pin down is that it is expressed with
 * machinery that already exists rather than a new kind of day: a
 * `departure` fixpoint on one side, a later start on the other. Nothing
 * in the solver knows what a transfer is, and that has to stay true.
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

/** Two invented towns, each in its own imported region. */
const WEST = { lat: 48.37, lon: 10.9 };
const EAST = { lat: 48.14, lon: 11.58 };

function spot(n: number, at: { lat: number; lon: number }): GeoPoiSearchSpot {
  return {
    osmRef: `node:${at.lon}:${n}`,
    type: "node",
    id: n,
    lat: at.lat + (n * 150) / 111_320,
    lon: at.lon,
    distanceM: n * 150,
    detourM: null,
    name: `Sehenswürdigkeit ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["sight"],
    wikidataQid: null,
    wikipedia: null,
    openingHours: null,
    cuisine: null,
    wheelchair: null,
    outdoorSeating: null,
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

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `tr-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(user.id),
    permissions: ["photos.view"],
  });
  await seedRegion("europe/west", "nom_west", [48.2, 10.5, 48.6, 11.2]);
  await seedRegion("europe/east", "nom_east", [48.0, 11.3, 48.4, 11.9]);
  geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", Array.from({ length: 24 }, (_, i) => spot(i + 1, WEST)));
  geo.setSearchSpots("nom_east", Array.from({ length: 24 }, (_, i) => spot(i + 1, EAST)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

/** Two legs, the second reached by a midday train. */
function twoLegs(transfer: Record<string, unknown>) {
  return createTripPlan({
    legs: [
      { title: "Weststadt", anchor: WEST, days: 2 },
      { title: "Oststadt", anchor: EAST, days: 2, transfer },
    ],
  });
}

describe("a transfer between two legs", () => {
  it("ends the departure day early, on the leg being left", async () => {
    const { plan } = await twoLegs({ departAt: "13:00", arriveAt: "16:00", travelMinutes: 20 });

    const west = plan.legs[0];
    // The departure lands on the *last* day of the leg being left, not
    // the first day of the one being entered.
    expect(west.days[0].fixpoints).toEqual([]);
    const [departure] = west.days[1].fixpoints;
    expect(departure.kind).toBe("departure");
    expect(departure.startMinutes).toBe(13 * 60);
    expect(departure.label).toBe("Weiterreise nach Oststadt");

    // 13:00 − 20 travel − 20 buffer binds at 12:20, so the afternoon and
    // evening of the leaving day are gone.
    expect(west.days[0].blocks.map((b) => b.id)).toContain("evening");
    expect(west.days[1].blocks.map((b) => b.id)).not.toContain("evening");
    expect(west.days[1].blocks.map((b) => b.id)).not.toContain("afternoon");
  });

  it("starts the arrival day at the arrival, on the leg being entered", async () => {
    const { plan } = await twoLegs({ departAt: "13:00", arriveAt: "16:00" });

    const east = plan.legs[1];
    // Arriving at 16:00 removes the morning and the midday outright —
    // a "Vormittag" beginning at four would be a lie. The afternoon is
    // entered part-way: it nominally ran 14:00–17:30, so ninety minutes
    // of it survive, then the evening is whole.
    expect(east.days[0].blocks.map((b) => b.id)).toEqual(["afternoon", "evening"]);
    const afternoon = east.days[0].blocks[0];
    expect(afternoon.budgetMinutes).toBe(90);
    expect(east.days[0].blocks[1].budgetMinutes).toBe(120);

    // The second day of the leg is a full day again.
    expect(east.days[1].blocks.map((b) => b.id)).toHaveLength(4);
  });

  it("names both halves in the dropped-block report", async () => {
    const { droppedBlocks } = await twoLegs({ departAt: "13:00", arriveAt: "16:00", travelMinutes: 20 });

    // Leaving: the afternoon and evening of leg 0, day 1.
    expect(droppedBlocks).toContainEqual(
      expect.objectContaining({ legIndex: 0, dayIndex: 1, id: "afternoon" }),
    );
    // Arriving: the morning and midday of leg 1, day 0.
    expect(droppedBlocks).toContainEqual(
      expect.objectContaining({ legIndex: 1, dayIndex: 0, id: "morning" }),
    );
  });

  it("removes the blocks the day has already passed rather than shifting them", async () => {
    // The mistake this guards against: blocks are relative, so a later
    // start would happily slide "Vormittag" to 16:00 and plan a full
    // morning's worth of spots into the evening.
    const { plan, droppedBlocks } = await twoLegs({ arriveAt: "16:00" });
    const arrivalDay = plan.legs[1].days[0];
    expect(arrivalDay.blocks.map((b) => b.id)).not.toContain("morning");
    expect(droppedBlocks!.find((d) => d.legIndex === 1 && d.id === "morning")?.reason)
      .toContain("16:00");
  });

  it("leaves the departure day whole when only an arrival is known", async () => {
    // A flight booked one way round: you know when you land, not when
    // the taxi leaves. Guessing the other half would be worse than
    // leaving the day as it was.
    const { plan } = await twoLegs({ arriveAt: "16:00" });
    expect(plan.legs[0].days[1].fixpoints).toEqual([]);
    expect(plan.legs[0].days[1].blocks.map((b) => b.id)).toHaveLength(4);
  });

  it("ignores a transfer on the first leg", async () => {
    // Nobody transfers into the start of a trip; how they got to the
    // first city is not this plan's business.
    const { plan } = await createTripPlan({
      legs: [{ title: "Weststadt", anchor: WEST, transfer: { departAt: "08:00", arriveAt: "11:00" } }],
    });
    expect(plan.legs[0].days[0].fixpoints).toEqual([]);
    expect(plan.legs[0].days[0].blocks).toHaveLength(4);
  });

  it("takes a label from the caller when there is one", async () => {
    const { plan } = await twoLegs({ departAt: "13:00", label: "ICE 599" });
    expect(plan.legs[0].days[1].fixpoints[0].label).toBe("ICE 599");
  });

  it("refuses a transfer time that is not a time", async () => {
    await expect(twoLegs({ departAt: "mittags" })).rejects.toThrow(/departAt/);
    await expect(twoLegs({ arriveAt: "25:00" })).rejects.toThrow(/arriveAt/);
  });
});
