/**
 * Changing how a trip is planned, after it was planned (§4.1, §6.2).
 *
 * Three things have to hold, and each of them loses something real when
 * it does not: a setting that changes nothing is a lie, a re-plan that
 * rewrites a settled day destroys a record, and one that drops the
 * pool's manual entries throws away somebody's own research (§9.2).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import {
  createTripPlan,
  getTripPlan,
  planPendingTrip,
  setTripStopStatus,
  updateTripSettings,
} from "./plans";
import { addFind } from "./add-find";

/**
 * The region lookup goes to Geofabrik's index over the network. Faked
 * here so the suite is not at the mercy of a download — what is under
 * test is what the planner does with the answer, not the index itself.
 */
vi.mock("../osm-admin/region.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../osm-admin/region.service")>();
  return {
    ...actual,
    suggestForCoord: async () => ({
      slug: "europe/portugal",
      pbfUrl: "https://example.com/pt.pbf",
      pbfSizeMb: 400,
      autoApprove: false,
    }),
    createPending: async () => ({
      slug: "europe/portugal",
      status: "pending_approval" as const,
      created: true,
    }),
  };
});

const WEST = { lat: 48.37, lon: 10.9 };

function spot(n: number, over: Partial<GeoPoiSearchSpot> = {}): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: WEST.lat + n * 0.0005,
    lon: WEST.lon,
    distanceM: n * 60,
    detourM: null,
    name: `Museum ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    // Prominence, so these survive the "worth a visit" filter (§10.5).
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
    ...over,
  };
}

let geo: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `settings-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(user.id),
    permissions: ["photos.view"],
  });
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
  geo.setSearchSpots("nom_west", Array.from({ length: 10 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function plan(pace: "relaxed" | "normal" | "packed" = "normal") {
  const { plan } = await createTripPlan({
    legs: [{ title: "Weststadt", anchor: WEST, radiusM: 4_000 }],
    pace,
  });
  return plan;
}

const stopCount = (p: { legs: { days: { blocks: { stops: unknown[] }[] }[] }[] }) =>
  p.legs[0].days[0].blocks.reduce((n, b) => n + b.stops.length, 0);

describe("PATCH /trip-planner/plans/:planId/settings", () => {
  it("changes the days, not just the stored value", async () => {
    // A setting the plan does not act on is a switch with nothing behind
    // it. A relaxed day has smaller block budgets, so it holds less.
    const created = await plan("packed");
    const before = stopCount(created);

    const { plan: after } = await updateTripSettings({ planId: created.id, pace: "relaxed" });

    expect(stopCount(after)).toBeLessThan(before);
  });

  it("keeps what the request did not mention", async () => {
    const created = await plan();
    await updateTripSettings({ planId: created.id, interests: ["barock"] });
    await updateTripSettings({ planId: created.id, pace: "relaxed" });

    const { plan: after } = await getTripPlan({ planId: created.id });
    expect(after.constraints.interests).toEqual(["barock"]);
    expect(after.constraints.pace).toBe("relaxed");
  });

  it("keeps the frame the traveller set", async () => {
    // The anchor, the mode, the dates and the search radius are not
    // what a pace change is about — and the radius is only reproducible
    // because the leg records it (migration 0165).
    const created = await plan();
    const { plan: after } = await updateTripSettings({ planId: created.id, pace: "relaxed" });

    expect(after.legs[0].id).toBe(created.legs[0].id);
    expect(after.legs[0].anchor).toEqual(created.legs[0].anchor);
    expect(after.legs[0].radiusM).toBe(4_000);
    const searches = geo.getSearchCalls().map((c) => c.query.center?.radiusM);
    expect(new Set(searches)).toEqual(new Set([4_000]));
  });

  it("does not throw away what somebody added by hand", async () => {
    // §9.2: a find is somebody's own research. Losing it to change the
    // pace is not a trade anyone offered.
    const created = await plan();
    await addFind({
      planId: created.id,
      lat: WEST.lat + 0.02,
      lon: WEST.lon,
      name: "Café Beispielhof",
      note: "beste Pastéis laut Blog",
      dwellMinutes: 30,
    });

    await updateTripSettings({ planId: created.id, pace: "relaxed" });

    const { plan: after } = await getTripPlan({ planId: created.id });
    const mine = after.legs[0].pool.find((c) => c.name === "Café Beispielhof");
    expect(mine).toBeDefined();
    expect(mine?.reasons.join(" ")).toContain("beste Pastéis laut Blog");
  });

  it("refuses to re-plan a day that has been started", async () => {
    const created = await plan();
    const first = created.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    await setTripStopStatus({ planId: created.id, stopId: first.rowId, status: "done" });

    await expect(updateTripSettings({ planId: created.id, pace: "relaxed" }))
      .rejects.toThrow(/abgehakt/);
  });

  it("still records a setting on a started trip when asked to", async () => {
    const created = await plan();
    const first = created.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    await setTripStopStatus({ planId: created.id, stopId: first.rowId, status: "done" });

    await updateTripSettings({ planId: created.id, pace: "relaxed", replan: false });

    const { plan: after } = await getTripPlan({ planId: created.id });
    expect(after.constraints.pace).toBe("relaxed");
    // The day is untouched, which is the whole point of replan: false.
    expect(stopCount(after)).toBe(stopCount(created));
  });

  it("renames without touching anything else", async () => {
    const created = await plan();
    await updateTripSettings({ planId: created.id, title: "  Herbstferien  ", replan: false });
    const { plan: after } = await getTripPlan({ planId: created.id });
    expect(after.title).toBe("Herbstferien");
  });

  it("does not change a plan that is not yours", async () => {
    await expect(updateTripSettings({ planId: 999_999, pace: "relaxed" }))
      .rejects.toThrow(/plan not found/);
  });
});

describe("a trip in a region nobody has imported (§4.3)", () => {
  /**
   * The planner used to refuse outright: `no imported OSM region covers
   * this location`. Everything typed was lost over a download the
   * traveller had no way to arrange, and §4.3 already has a resolution
   * for "framed but not filled in".
   */
  beforeEach(async () => {
    // A city the seeded region does not cover.
    await db.delete(osmRegionImports);
    clearRouterCache();
  });

  it("saves the trip with its days framed, and asks for the region", async () => {
    const { plan, pendingRegions } = await createTripPlan({
      legs: [{ title: "Weit weg", anchor: { lat: 38.71, lon: -9.14 }, days: 2 }],
    });

    // The frame is there: days, blocks, budgets — everything but spots.
    expect(plan.legs[0].days).toHaveLength(2);
    expect(plan.legs[0].days[0].blocks.length).toBeGreaterThan(0);
    expect(plan.legs[0].days[0].blocks.every((b) => b.stops.length === 0)).toBe(true);

    // And it says what it is waiting for, rather than looking broken.
    expect(pendingRegions).toHaveLength(1);
    expect(pendingRegions?.[0].legIndex).toBe(0);
    expect(pendingRegions?.[0].slug).toBeTruthy();
  });

  it("refuses to fill it in while the region is still missing", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "Weit weg", anchor: { lat: 38.71, lon: -9.14 }, days: 1 }],
    });

    // "It is still loading" is something a traveller can wait on; an
    // empty day with no explanation is not.
    await expect(planPendingTrip({ planId: plan.id })).rejects.toThrow(/noch nicht da/);
  });

  it("fills it in once the region has arrived", async () => {
    const { plan } = await createTripPlan({
      legs: [{ title: "Weit weg", anchor: { lat: 38.71, lon: -9.14 }, days: 1 }],
    });
    expect(plan.legs[0].days[0].blocks.every((b) => b.stops.length === 0)).toBe(true);

    // The import finished: the region is now ready and holds spots.
    await db.insert(osmRegionImports).values({
      slug: "europe/portugal",
      geofabrik_url: "https://example.com/pt.pbf",
      postgres_db: "nom_pt",
      bbox_min_lat: 36.9,
      bbox_min_lon: -9.6,
      bbox_max_lat: 42.2,
      bbox_max_lon: -6.1,
      status: "ready_running",
    });
    clearRouterCache();
    geo.setSearchSpots("nom_pt", Array.from({ length: 6 }, (_, i) => ({
      ...spot(i + 1),
      lat: 38.71 + i * 0.0005,
      lon: -9.14,
    })));

    const { plan: filled } = await planPendingTrip({ planId: plan.id });

    expect(filled.legs[0].days[0].blocks.some((b) => b.stops.length > 0)).toBe(true);
  });
});

describe("changing the frame: the mode and the dates", () => {
  it("changes the mode of every leg", async () => {
    const created = await plan();
    expect(created.legs[0].mode).toBe("foot");

    const { plan: after } = await updateTripSettings({ planId: created.id, mode: "transit" });

    expect(after.legs[0].mode).toBe("transit");
    // And it stays changed: the re-plan rewrites days, not legs, so a
    // mode that only reached the solver would be back to "foot" here.
    const { plan: reloaded } = await getTripPlan({ planId: created.id });
    expect(reloaded.legs[0].mode).toBe("transit");
  });

  it("still walks the short hops on a transit leg", async () => {
    // "ÖPNV" does not mean "take the tram across the square". With
    // every spot inside walking distance the day comes out exactly as
    // the walking day did — no fares, no waiting, no difference.
    const created = await plan();
    const before = created.legs[0].days[0].blocks;

    const { plan: after } = await updateTripSettings({ planId: created.id, mode: "transit" });

    const now = after.legs[0].days[0].blocks;
    expect(now.map((b) => b.stops.map((s) => s.osmRef)))
      .toEqual(before.map((b) => b.stops.map((s) => s.osmRef)));
    // Never dearer than walking, hop by hop — the property that makes
    // "ÖPNV" a safe choice for a city day rather than a gamble.
    for (const [i, block] of now.entries()) {
      expect(block.usedMinutes).toBeLessThanOrEqual(before[i].usedMinutes);
    }
  });

  it("reaches on a transit leg what a walking leg cannot", async () => {
    // ~3 km out: a 52-minute walk, past any sane longest-walk limit,
    // and a 21-minute ride. This is what choosing "ÖPNV" is for.
    geo.setSearchSpots("nom_west", [
      spot(1),
      spot(2),
      { ...spot(3), osmRef: "node:99", id: 99, name: "Museum am Rand", lat: WEST.lat + 0.027 },
    ]);
    const created = await plan();
    const walked = created.legs[0].days.flatMap((d) =>
      d.blocks.flatMap((b) => b.stops.map((s) => s.osmRef)));
    expect(walked).not.toContain("node:99");

    const { plan: after } = await updateTripSettings({ planId: created.id, mode: "transit" });

    const ridden = after.legs[0].days.flatMap((d) =>
      d.blocks.flatMap((b) => b.stops.map((s) => s.osmRef)));
    expect(ridden).toContain("node:99");
  });

  it("puts dates on a trip that had none", async () => {
    const created = await plan();
    expect(created.legs[0].startDate).toBeNull();

    const { plan: after } = await updateTripSettings({
      planId: created.id,
      startDate: "2026-09-17",
    });

    expect(after.legs[0].startDate).toBe("2026-09-17");
  });

  it("moves the dates without planning the trip again", async () => {
    // A flight that moved is not a reason to lose the plan. The stops
    // stay exactly as they were, in the same order.
    const created = await plan();
    await updateTripSettings({ planId: created.id, startDate: "2026-09-17" });
    const before = (await getTripPlan({ planId: created.id })).plan;
    const refs = before.legs[0].days[0].blocks.flatMap((b) => b.stops.map((s) => s.osmRef));

    const { plan: after } = await updateTripSettings({
      planId: created.id,
      startDate: "2026-10-01",
    });

    expect(after.legs[0].startDate).toBe("2026-10-01");
    expect(after.legs[0].days[0].blocks.flatMap((b) => b.stops.map((s) => s.osmRef)))
      .toEqual(refs);
  });

  it("moves the dates of a trip somebody has already begun", async () => {
    // The refusal exists to protect a record of what happened. A date
    // does not rewrite that record, so refusing here would only cost
    // the traveller the one correction they actually need on the road.
    const created = await plan();
    const stop = created.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    await setTripStopStatus({ planId: created.id, stopId: stop.rowId, status: "done" });

    const { plan: after } = await updateTripSettings({
      planId: created.id,
      startDate: "2026-09-17",
    });

    expect(after.legs[0].startDate).toBe("2026-09-17");
  });

  it("still refuses to re-plan a begun trip for a new mode", async () => {
    const created = await plan();
    const stop = created.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    await setTripStopStatus({ planId: created.id, stopId: stop.rowId, status: "done" });

    await expect(updateTripSettings({ planId: created.id, mode: "transit" }))
      .rejects.toThrow(/abgehakt/);

    // And the refusal left nothing half-written: the leg still has the
    // mode it was planned with, not the one the days do not match.
    const { plan: after } = await getTripPlan({ planId: created.id });
    expect(after.legs[0].mode).toBe("foot");
  });

  it("takes the dates off again", async () => {
    const created = await plan();
    await updateTripSettings({ planId: created.id, startDate: "2026-09-17" });

    const { plan: after } = await updateTripSettings({ planId: created.id, startDate: null });

    expect(after.legs[0].startDate).toBeNull();
  });

  it("refuses a date that is not a date", async () => {
    const created = await plan();
    await expect(updateTripSettings({ planId: created.id, startDate: "17.09.2026" }))
      .rejects.toThrow(/YYYY-MM-DD/);
    await expect(updateTripSettings({ planId: created.id, startDate: "2026-02-30" }))
      .rejects.toThrow(/YYYY-MM-DD/);
  });
});
