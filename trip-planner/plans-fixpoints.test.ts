/**
 * Hard times, at the endpoint: from the request to a tighter day.
 *
 * The arithmetic is covered in fixpoints.test.ts. What is this
 * endpoint's own is the wiring: a fixpoint given per leg-day has to
 * reach the schedule *before* the solver fills anything, so the block
 * the last train binds really does hold fewer spots — and the block it
 * squeezed out has to be reported rather than silently missing.
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

const ANCHOR = { lat: 48.37, lon: 10.9 };
const DB = "nom_europe_west";

/** Spots strung out north of the anchor, so a block fits several. */
function spot(n: number): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: ANCHOR.lat + (n * 150) / 111_320,
    lon: ANCHOR.lon,
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
    dietVegetarian: null,
    dietVegan: null,
    phone: null,
    website: null,
    facadeAzimuth: null,
  };
}

let geo: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `fix-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(user.id),
    permissions: ["photos.view"],
  });
  await db.insert(osmRegionImports).values({
    slug: "europe/west",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: DB,
    bbox_min_lat: 48.2,
    bbox_min_lon: 10.5,
    bbox_max_lat: 48.6,
    bbox_max_lon: 11.2,
    status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  geo.setSearchSpots(DB, Array.from({ length: 24 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("POST /trip-planner/plans with fixpoints", () => {
  it("fits less into the evening when the last train binds it", async () => {
    const withoutTrain = await createTripPlan({ anchor: ANCHOR });
    const withTrain = await createTripPlan({
      legs: [
        {
          anchor: ANCHOR,
          fixpoints: [
            {
              dayIndex: 0,
              label: "Letzter Zug 18:40",
              kind: "departure",
              at: "18:40",
              travelMinutes: 15,
              bufferMinutes: 20,
            },
          ],
        },
      ],
    });

    const evening = (r: Awaited<ReturnType<typeof createTripPlan>>) =>
      r.plan.legs[0].days[0].blocks.find((b) => b.id === "evening");

    // The default evening runs 17:30–19:30; the train binds at 18:05.
    expect(evening(withoutTrain)!.budgetMinutes).toBe(120);
    expect(evening(withTrain)!.budgetMinutes).toBe(35);
    expect(evening(withTrain)!.stops.length).toBeLessThan(
      evening(withoutTrain)!.stops.length,
    );
  });

  it("reports the block a fixpoint left no room for", async () => {
    const { plan, droppedBlocks } = await createTripPlan({
      legs: [
        {
          anchor: ANCHOR,
          days: 2,
          fixpoints: [
            {
              dayIndex: 1,
              label: "Letzter Zug 17:45",
              kind: "departure",
              at: "17:45",
              travelMinutes: 15,
            },
          ],
        },
      ],
    });

    expect(plan.legs[0].days[0].blocks.map((b) => b.id)).toContain("evening");
    expect(plan.legs[0].days[1].blocks.map((b) => b.id)).not.toContain("evening");
    expect(droppedBlocks).toEqual([
      expect.objectContaining({ legIndex: 0, dayIndex: 1, id: "evening" }),
    ]);
    expect(droppedBlocks![0].reason).toContain("Letzter Zug 17:45");
  });

  it("says nothing about dropped blocks when nothing was dropped", async () => {
    const { droppedBlocks } = await createTripPlan({ anchor: ANCHOR });
    expect(droppedBlocks).toEqual([]);
  });

  it("keeps the fixpoint on the plan, so a reload still knows the frame", async () => {
    const { plan } = await createTripPlan({
      legs: [
        {
          anchor: ANCHOR,
          fixpoints: [{ dayIndex: 0, label: "Führung", at: "14:00", durationMinutes: 90 }],
        },
      ],
    });

    const [fix] = plan.legs[0].days[0].fixpoints;
    expect(fix.label).toBe("Führung");
    expect(fix.startMinutes).toBe(14 * 60);
    expect(fix.durationMinutes).toBe(90);
    expect(fix.kind).toBe("appointment");
  });

  it("moves the day's start when the leg says so", async () => {
    const { plan } = await createTripPlan({
      legs: [{ anchor: ANCHOR, dayStartsAt: "07:30" }],
    });
    // Nothing to assert on the clock in the stored plan — but an early
    // start must not itself drop a block.
    expect(plan.legs[0].days[0].blocks).toHaveLength(4);
  });

  it("refuses a time that is not a time", async () => {
    for (const at of ["abends", "25:00", "18:60", "18"]) {
      await expect(
        createTripPlan({ legs: [{ anchor: ANCHOR, fixpoints: [{ dayIndex: 0, label: "x", at }] }] }),
      ).rejects.toThrow(/HH:MM/);
    }
    await expect(
      createTripPlan({ legs: [{ anchor: ANCHOR, dayStartsAt: "morgens" }] }),
    ).rejects.toThrow(/dayStartsAt/);
  });

  it("refuses a fixpoint on a day the leg does not have", async () => {
    await expect(
      createTripPlan({
        legs: [{ anchor: ANCHOR, days: 2, fixpoints: [{ dayIndex: 5, label: "x", at: "12:00" }] }],
      }),
    ).rejects.toThrow(/between 0 and 1/);
  });

  it("refuses a fixpoint with no label to show", async () => {
    await expect(
      createTripPlan({
        legs: [{ anchor: ANCHOR, fixpoints: [{ dayIndex: 0, label: "   ", at: "12:00" }] }],
      }),
    ).rejects.toThrow(/label is required/);
  });

  it("refuses a kind it cannot reason about", async () => {
    await expect(
      createTripPlan({
        legs: [
          {
            anchor: ANCHOR,
            fixpoints: [
              { dayIndex: 0, label: "x", at: "12:00", kind: "maybe" as never },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/kind must be one of/);
  });

  it("ends the day at the departure's place, not back at the hotel", async () => {
    // The spots run north of the anchor; the station is south of it.
    // With the last train named *and located*, the evening has to
    // finish at the platform — the walk back to a hotel already checked
    // out of is a walk nobody makes (§4.4).
    const station = { lat: ANCHOR.lat - 2_000 / 111_320, lon: ANCHOR.lon };
    geo.setSearchSpots(DB, [
      spot(2),
      { ...spot(3), osmRef: "node:south", lat: station.lat + 300 / 111_320, lon: station.lon },
    ]);

    const { plan } = await createTripPlan({
      legs: [{
        anchor: ANCHOR,
        fixpoints: [{
          dayIndex: 0, label: "Zug 18:40", at: "18:40", kind: "departure",
          travelMinutes: 15, ...station,
        }],
      }],
    });

    const stops = plan.legs[0].days[0].blocks.flatMap((b) => b.stops);
    expect(stops.length).toBeGreaterThan(1);
    expect(stops.at(-1)?.osmRef).toBe("node:south");
  });

  it("leaves the day alone when the departure names no place", async () => {
    // Only a time: the frame tightens as it always did, and the day
    // still comes home. A location is an addition, never a condition.
    const { plan } = await createTripPlan({
      legs: [{
        anchor: ANCHOR,
        fixpoints: [{ dayIndex: 0, label: "Zug 18:40", at: "18:40", kind: "departure" }],
      }],
    });

    expect(plan.legs[0].days[0].blocks.flatMap((b) => b.stops).length).toBeGreaterThan(0);
  });

  it("does not charge the walk to the station twice", async () => {
    // The guard cuts the last block by `travelMinutes`; the route now
    // also ends at the platform. Both at once made the day stop half an
    // hour before the train and then spend the real walk out of what
    // was left — a stop nobody had to give up.
    const station = { lat: ANCHOR.lat - 2_000 / 111_320, lon: ANCHOR.lon };
    const departure = {
      dayIndex: 0, label: "Zug 18:40", at: "18:40", kind: "departure" as const,
      travelMinutes: 30,
    };

    const placed = await createTripPlan({
      legs: [{ anchor: ANCHOR, fixpoints: [{ ...departure, ...station }] }],
    });
    const typedOnly = await createTripPlan({
      legs: [{ anchor: ANCHOR, fixpoints: [departure] }],
    });

    const lastBudget = (plan: typeof placed) => {
      const blocks = plan.plan.legs[0].days[0].blocks;
      return blocks[blocks.length - 1].budgetMinutes;
    };
    // Same train, same buffer: the located one keeps the thirty minutes
    // the route is about to spend for real.
    expect(lastBudget(placed) - lastBudget(typedOnly)).toBe(30);
  });
});
