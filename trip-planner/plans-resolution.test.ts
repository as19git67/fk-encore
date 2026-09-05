/**
 * Two resolutions: coarse for the trip, fine for tomorrow (§4.3).
 *
 * Twenty days is about sixty blocks that nobody wants to review in
 * advance. So the whole trip gets its frame and its scored pool at
 * once, and only the next day or two get spots. What these tests hold
 * onto is that an undetailed day is not an empty one: it keeps its
 * blocks, its budgets and its fixpoints, because that frame is what the
 * family votes on — and that the pool is not spent on days nobody has
 * looked at yet.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, detailTripDay, setTripStopStatus } from "./plans";

const ANCHOR = { lat: 48.37, lon: 10.9 };
const DB = "nom_west";

/**
 * Spots on a small circle around the anchor rather than strung out in a
 * line, so that what is left in the pool after two days is still within
 * walking distance. A line makes the leftovers unreachable and the
 * "detail a later day" tests vacuous.
 */
function spot(n: number): GeoPoiSearchSpot {
  const angle = (n / 40) * 2 * Math.PI;
  const radiusM = 400;
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: ANCHOR.lat + (radiusM * Math.cos(angle)) / 111_320,
    lon:
      ANCHOR.lon +
      (radiusM * Math.sin(angle)) / (111_320 * Math.cos((ANCHOR.lat * Math.PI) / 180)),
    distanceM: radiusM,
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

const stopsIn = (day: { blocks: { stops: unknown[] }[] }) =>
  day.blocks.reduce((n, b) => n + b.stops.length, 0);

let geo: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `res-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
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
  geo.setSearchSpots(DB, Array.from({ length: 40 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("planning a long trip", () => {
  it("details the next two days and frames the rest", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 6 });
    const days = plan.legs[0].days;

    expect(days.map((d) => d.detailed)).toEqual([true, true, false, false, false, false]);
    expect(stopsIn(days[1])).toBeGreaterThan(0);
    expect(stopsIn(days[2])).toBe(0);
  });

  it("gives an undetailed day its frame, not nothing", async () => {
    const { plan } = await createTripPlan({
      legs: [
        {
          anchor: ANCHOR,
          days: 4,
          fixpoints: [
            { dayIndex: 3, label: "Letzter Zug 17:45", kind: "departure", at: "17:45", travelMinutes: 15 },
          ],
        },
      ],
    });

    const lastDay = plan.legs[0].days[3];
    expect(lastDay.detailed).toBe(false);
    // The frame is trip-resolution information: it is what the family
    // votes on, so it exists from the start.
    expect(lastDay.blocks.map((b) => b.id)).toEqual(["morning", "midday", "afternoon"]);
    expect(lastDay.fixpoints.map((f) => f.label)).toEqual(["Letzter Zug 17:45"]);
    // The train has already shortened the afternoon, before any spot
    // was ever considered for that day.
    expect(lastDay.blocks[2].budgetMinutes).toBe(190);
  });

  it("does not spend the pool on days nobody has looked at", async () => {
    const short = await createTripPlan({ anchor: ANCHOR, days: 2 });
    const long = await createTripPlan({ anchor: ANCHOR, days: 6 });
    // Six days planned in full would drain the pool; two days' worth of
    // spots come out of it either way.
    expect(long.plan.legs[0].pool.length).toBe(short.plan.legs[0].pool.length);
  });

  it("spends the detail budget across the trip, not per leg", async () => {
    await db.insert(osmRegionImports).values({
      slug: "europe/east",
      geofabrik_url: "https://example.com/x.pbf",
      postgres_db: "nom_east",
      bbox_min_lat: 48.0,
      bbox_min_lon: 11.3,
      bbox_max_lat: 48.4,
      bbox_max_lon: 11.9,
      status: "ready_running",
    });
    geo.setSearchSpots("nom_east", Array.from({ length: 10 }, (_, i) => spot(i + 1)));

    const { plan } = await createTripPlan({
      legs: [
        { anchor: ANCHOR, days: 2 },
        { anchor: { lat: 48.14, lon: 11.58 }, days: 2 },
      ],
    });

    // "The next two days" means the next two days of the trip, whichever
    // leg they fall in — the second leg is still weeks away.
    expect(plan.legs[0].days.map((d) => d.detailed)).toEqual([true, true]);
    expect(plan.legs[1].days.map((d) => d.detailed)).toEqual([false, false]);
  });

  it("lets a weekend trip have both resolutions at once", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 2 });
    expect(plan.legs[0].days.every((d) => d.detailed)).toBe(true);
  });

  it("plans the lot when the caller asks for it", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 4, detailDays: 4 });
    expect(plan.legs[0].days.every((d) => d.detailed)).toBe(true);
  });

  it("plans none when the caller wants only the pool", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 3, detailDays: 0 });
    expect(plan.legs[0].days.every((d) => !d.detailed)).toBe(true);
    // Everything the search found is still available.
    expect(plan.legs[0].pool.length).toBe(40);
  });

  it("refuses a negative detail horizon", async () => {
    await expect(
      createTripPlan({ anchor: ANCHOR, detailDays: -1 }),
    ).rejects.toThrow(/detailDays/);
  });
});

describe("detailing a day on the eve", () => {
  it("fills it from the leg's pool and takes what it used", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 4 });
    const poolBefore = plan.legs[0].pool.length;

    const { plan: after } = await detailTripDay({ planId: plan.id, dayIndex: 2 });

    const day = after.legs[0].days[2];
    expect(day.detailed).toBe(true);
    expect(stopsIn(day)).toBeGreaterThan(0);
    expect(after.legs[0].pool.length).toBe(poolBefore - stopsIn(day));
  });

  it("leaves the other days as they were", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 4 });
    const before = stopsIn(plan.legs[0].days[0]);

    const { plan: after } = await detailTripDay({ planId: plan.id, dayIndex: 2 });

    expect(stopsIn(after.legs[0].days[0])).toBe(before);
    expect(after.legs[0].days[3].detailed).toBe(false);
  });

  it("honours the fixpoints the day was framed with", async () => {
    const { plan } = await createTripPlan({
      legs: [
        {
          anchor: ANCHOR,
          days: 4,
          fixpoints: [
            { dayIndex: 3, label: "Letzter Zug 17:45", kind: "departure", at: "17:45", travelMinutes: 15 },
          ],
        },
      ],
    });

    const { plan: after } = await detailTripDay({ planId: plan.id, dayIndex: 3 });
    const day = after.legs[0].days[3];
    // The evening never existed for this day, and detailing it does not
    // bring it back.
    expect(day.blocks.map((b) => b.id)).toEqual(["morning", "midday", "afternoon"]);
    expect(day.blocks[2].budgetMinutes).toBe(190);
  });

  it("refuses to redo a day that is already planned", async () => {
    // Silently re-solving would discard whatever was pinned or already
    // visited; changing a planned day is what redistribute is for.
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 4 });
    await expect(detailTripDay({ planId: plan.id, dayIndex: 0 })).rejects.toThrow(
      /already planned/,
    );
  });

  it("says which day it could not find", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 4 });
    await expect(detailTripDay({ planId: plan.id, dayIndex: 9 })).rejects.toThrow(/day 9/);
    await expect(
      detailTripDay({ planId: plan.id, legIndex: 3, dayIndex: 0 }),
    ).rejects.toThrow(/leg 3/);
  });

  it("does not hand a plan to another user", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 4 });
    const [other] = await db
      .insert(users)
      .values({ email: `other-${Date.now()}@test.invalid`, name: "Other", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(other.id),
      permissions: ["photos.view"],
    });

    await expect(detailTripDay({ planId: plan.id, dayIndex: 2 })).rejects.toThrow(
      /plan not found/,
    );
  });
});

describe("the hour each block begins", () => {
  it("is kept, so the day can be shown as well as planned", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 2 });
    const blocks = plan.legs[0].days[0].blocks;
    // The default day starts at 09:00 and the blocks run back to back.
    expect(blocks.map((b) => b.startMinutes)).toEqual([
      9 * 60,
      9 * 60 + 210,
      9 * 60 + 210 + 90,
      9 * 60 + 210 + 90 + 210,
    ]);
  });

  it("follows the fixpoints that moved the block", async () => {
    const { plan } = await createTripPlan({
      legs: [
        {
          anchor: ANCHOR,
          fixpoints: [
            { dayIndex: 0, label: "Führung", at: "14:00", durationMinutes: 90 },
          ],
        },
      ],
    });
    const blocks = plan.legs[0].days[0].blocks;
    // The tour binds at 13:40 and ends at 15:30; the afternoon cannot
    // begin before that.
    expect(blocks.find((b) => b.id === "afternoon")?.startMinutes).toBe(15 * 60 + 30);
  });

  it("is kept for a day that has no spots yet", async () => {
    // The frame is trip-resolution information, so its hours exist from
    // the start (§4.3).
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 4 });
    const later = plan.legs[0].days[3];
    expect(later.detailed).toBe(false);
    expect(later.blocks[0].startMinutes).toBe(9 * 60);
  });

  it("survives detailing the day later", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 4 });
    const before = plan.legs[0].days[2].blocks.map((b) => b.startMinutes);
    const { plan: after } = await detailTripDay({ planId: plan.id, dayIndex: 2 });
    expect(after.legs[0].days[2].blocks.map((b) => b.startMinutes)).toEqual(before);
  });
});

describe("ticking a spot off", () => {
  it("marks it done without rearranging the day", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 2 });
    const day = plan.legs[0].days[0];
    const before = day.blocks.flatMap((b) => b.stops.map((s) => s.osmRef));
    const target = day.blocks.flatMap((b) => b.stops)[0];

    const { plan: after } = await setTripStopStatus({
      planId: plan.id,
      stopId: target.rowId,
      status: "done",
    });

    const stops = after.legs[0].days[0].blocks.flatMap((b) => b.stops);
    expect(stops.find((s) => s.rowId === target.rowId)?.status).toBe("done");
    // Swiping a spot done is not a request to replan: the order and the
    // rest of the day are untouched (§8.5).
    expect(stops.map((s) => s.osmRef)).toEqual(before);
    expect(after.legs[0].pool.length).toBe(plan.legs[0].pool.length);
  });

  it("undoes a mistaken swipe", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 2 });
    const target = plan.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];

    await setTripStopStatus({ planId: plan.id, stopId: target.rowId, status: "skipped" });
    const { plan: after } = await setTripStopStatus({
      planId: plan.id,
      stopId: target.rowId,
      status: "planned",
    });

    const stop = after.legs[0].days[0].blocks
      .flatMap((b) => b.stops)
      .find((s) => s.rowId === target.rowId);
    expect(stop?.status).toBe("planned");
  });

  it("stops counting a done spot against the block's used minutes", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 2 });
    const block = plan.legs[0].days[0].blocks.find((b) => b.stops.length > 0)!;
    const usedBefore = block.usedMinutes;

    const { plan: after } = await setTripStopStatus({
      planId: plan.id,
      stopId: block.stops[0].rowId,
      status: "skipped",
    });

    const updated = after.legs[0].days[0].blocks.find((b) => b.id === block.id)!;
    expect(updated.usedMinutes).toBeLessThan(usedBefore);
  });

  it("refuses a status it cannot reason about", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 2 });
    const target = plan.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    await expect(
      setTripStopStatus({ planId: plan.id, stopId: target.rowId, status: "vielleicht" as never }),
    ).rejects.toThrow(/status must be one of/);
  });

  it("does not touch another user's stop", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 2 });
    const target = plan.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];

    const [other] = await db
      .insert(users)
      .values({ email: `other-${Date.now()}@test.invalid`, name: "Other", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(other.id),
      permissions: ["photos.view"],
    });

    await expect(
      setTripStopStatus({ planId: plan.id, stopId: target.rowId, status: "done" }),
    ).rejects.toThrow(/not found/);
  });
});
