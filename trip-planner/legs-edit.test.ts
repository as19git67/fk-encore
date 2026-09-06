/**
 * Changing the cities of a trip after it exists (§4.2, §6.2).
 *
 * The server has taken up to ten legs in one request since the
 * beginning; what it never had is anything after that. These are the
 * three gestures that make a twenty-day trip plannable the way twenty
 * days are actually planned — the city you decide on later, the hotel
 * that changed, the leg that fell through — and each of them can go
 * quietly wrong in a way the response still looks fine for: a leg that
 * silently reuses the wrong region, a transfer that frames only one of
 * its two ends, a renumbering that makes "leg 2" mean two things.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";

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

import { createTripPlan, getTripPlan, setTripStopStatus } from "./plans";
import { addTripLeg, removeTripLeg, updateTripLeg } from "./legs";
import { inviteToTrip } from "./shares";
import { addFind } from "./add-find";

/** Two invented towns, far enough apart to need two regions. */
const WEST = { lat: 48.37, lon: 10.9 };
const EAST = { lat: 48.14, lon: 11.58 };

function spot(n: number, at: { lat: number; lon: number }): GeoPoiSearchSpot {
  // The id encodes which town it is in, so a leg planned against the
  // wrong region is visible in the refs rather than only in a database
  // name nobody compares.
  const id = at === EAST ? 100 + n : n;
  return {
    osmRef: `node:${id}`,
    type: "node",
    id,
    lat: at.lat + n * 0.0005,
    lon: at.lon,
    distanceM: n * 60,
    detourM: null,
    name: `Museum ${id}`,
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

async function seedRegion(slug: string, dbName: string, bbox: [number, number, number, number]) {
  await db.insert(osmRegionImports).values({
    slug,
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: dbName,
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
    .values({ email: `legedit-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = user.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(ownerId),
    permissions: ["photos.view"],
  });
  await seedRegion("europe/west", "nom_west", [48.2, 10.5, 48.6, 11.2]);
  await seedRegion("europe/east", "nom_east", [48.0, 11.3, 48.4, 11.9]);
  geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", Array.from({ length: 8 }, (_, i) => spot(i + 1, WEST)));
  geo.setSearchSpots("nom_east", Array.from({ length: 8 }, (_, i) => spot(i + 1, EAST)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function oneLegPlan(over: Record<string, unknown> = {}) {
  const { plan } = await createTripPlan({
    title: "Erstmal eine Stadt",
    legs: [{ title: "Weststadt", anchor: WEST, days: 2, radiusM: 4_000 }],
    ...over,
  });
  return plan;
}

const stopRefs = (leg: { days: { blocks: { stops: { osmRef: string }[] }[] }[] }) =>
  leg.days.flatMap((d) => d.blocks.flatMap((b) => b.stops.map((s) => s.osmRef)));

describe("POST /trip-planner/plans/:planId/legs", () => {
  it("adds a city with its own region, anchor and pool", async () => {
    const created = await oneLegPlan();

    const { plan } = await addTripLeg({
      planId: created.id,
      title: "Oststadt",
      anchor: EAST,
      days: 2,
      radiusM: 4_000,
    });

    expect(plan.legs).toHaveLength(2);
    expect(plan.legs[1].title).toBe("Oststadt");
    expect(plan.legs[1].regionDb).toBe("nom_east");
    // Its own search, around its own anchor — a leg quietly reusing the
    // first one's region would look perfectly fine in the response.
    const searched = geo.getSearchCalls().map((c) => c.postgresDb);
    expect(searched).toContain("nom_east");
    // And what it planned really is from over there: every ref in the
    // new leg carries the eastern town's id range.
    const refs = stopRefs(plan.legs[1]);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((ref) => Number(ref.split(":")[1]) > 100)).toBe(true);
    // And the first leg is untouched.
    expect(stopRefs(plan.legs[0])).toEqual(stopRefs(created.legs[0]));
  });

  it("plans the new leg with the trip's settings, not with defaults", async () => {
    // A leg added on Tuesday has to come out like a leg named at the
    // start: same pace, same block budgets.
    const relaxed = await oneLegPlan({ pace: "relaxed" });
    const packed = await createTripPlan({
      title: "Zügig",
      legs: [{ title: "Weststadt", anchor: WEST, days: 2, radiusM: 4_000 }],
      pace: "packed",
    });

    const a = await addTripLeg({ planId: relaxed.id, title: "Ost", anchor: EAST, days: 1 });
    const b = await addTripLeg({ planId: packed.plan.id, title: "Ost", anchor: EAST, days: 1 });

    const budget = (p: typeof a.plan) =>
      p.legs[1].days[0].blocks.reduce((n, blk) => n + blk.budgetMinutes, 0);
    expect(budget(a.plan)).toBeLessThan(budget(b.plan));
  });

  it("puts a leg in the middle and renumbers the rest", async () => {
    const created = await oneLegPlan();
    await addTripLeg({ planId: created.id, title: "Zuletzt", anchor: EAST, days: 1 });

    const { plan } = await addTripLeg({
      planId: created.id,
      title: "Dazwischen",
      anchor: EAST,
      days: 1,
      position: 1,
    });

    expect(plan.legs.map((l) => l.title)).toEqual(["Weststadt", "Dazwischen", "Zuletzt"]);
    // Positions are what every endpoint addresses a leg by, so a hole
    // in the sequence would make "leg 2" mean two different things.
    expect(plan.legs.map((l) => l.position)).toEqual([0, 1, 2]);
  });

  it("frames both ends of a transfer", async () => {
    // §4.2: the day you leave has no evening, the day you arrive has no
    // morning. Both ends, or the plan promises a day nobody has.
    const created = await oneLegPlan();

    const { plan } = await addTripLeg({
      planId: created.id,
      title: "Oststadt",
      anchor: EAST,
      days: 2,
      transfer: { departAt: "09:30", arriveAt: "14:00", label: "Zug nach Oststadt" },
    });

    const lastDayOfFirst = plan.legs[0].days[plan.legs[0].days.length - 1];
    const departure = lastDayOfFirst.fixpoints.find((f) => f.kind === "departure");
    expect(departure?.label).toBe("Zug nach Oststadt");
    expect(departure?.startMinutes).toBe(9 * 60 + 30);

    // And the arrival day starts in the afternoon.
    const firstDayOfSecond = plan.legs[1].days[0];
    const earliest = Math.min(
      ...firstDayOfSecond.blocks.map((b) => b.startMinutes ?? Number.POSITIVE_INFINITY));
    expect(earliest).toBeGreaterThanOrEqual(14 * 60);
  });

  it("refuses to rewrite a day somebody has already begun", async () => {
    const created = await oneLegPlan();
    const stop = created.legs[0].days[1].blocks.flatMap((b) => b.stops)[0];
    await setTripStopStatus({ planId: created.id, stopId: stop.rowId, status: "done" });

    await expect(addTripLeg({
      planId: created.id,
      title: "Oststadt",
      anchor: EAST,
      transfer: { departAt: "09:30" },
    })).rejects.toThrow(/abgehakt/);

    // Nothing was written: the refusal came before the insert.
    const { plan } = await getTripPlan({ planId: created.id });
    expect(plan.legs).toHaveLength(1);
  });

  it("adds the city without a departure time even then", async () => {
    // Only the *departure* touches the previous leg. The city itself is
    // still addable — refusing it would make a begun trip unplannable.
    const created = await oneLegPlan();
    const stop = created.legs[0].days[1].blocks.flatMap((b) => b.stops)[0];
    await setTripStopStatus({ planId: created.id, stopId: stop.rowId, status: "done" });

    const { plan } = await addTripLeg({
      planId: created.id, title: "Oststadt", anchor: EAST,
      transfer: { arriveAt: "14:00" },
    });
    expect(plan.legs).toHaveLength(2);
  });

  it("does not re-plan the previous city for a fixpoint it already had", async () => {
    // The predecessor is touched only by a *departure time*. Testing
    // "does it have fixpoints?" instead would fire for a leg that
    // simply has a dentist's appointment on it — and then refuse the
    // whole addition once that day had begun.
    const { plan: created } = await createTripPlan({
      title: "Mit Termin",
      legs: [{
        title: "Weststadt", anchor: WEST, days: 2, radiusM: 4_000,
        fixpoints: [{ dayIndex: 0, label: "Zahnarzt", at: "11:00", durationMinutes: 45 }],
      }],
    });
    const stop = created.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    await setTripStopStatus({ planId: created.id, stopId: stop.rowId, status: "done" });

    const { plan } = await addTripLeg({
      planId: created.id, title: "Oststadt", anchor: EAST, days: 1,
      transfer: { arriveAt: "14:00" },
    });

    expect(plan.legs).toHaveLength(2);
    expect(plan.legs[0].days[0].fixpoints.map((f) => f.label)).toContain("Zahnarzt");
  });

  it("saves a leg whose region is not imported yet, and says so", async () => {
    // §4.3: framed but not filled in. Refusing would throw away
    // everything the traveller typed for a download they cannot start.
    const created = await oneLegPlan();

    const response = await addTripLeg({
      planId: created.id, title: "Weit weg", anchor: { lat: 38.71, lon: -9.14 }, days: 2,
    });

    expect(response.plan.legs).toHaveLength(2);
    expect(response.pendingRegions?.[0]?.legIndex).toBe(1);
    expect(response.plan.legs[1].days).toHaveLength(2);
    expect(response.plan.legs[1].days.every((d) =>
      d.blocks.every((b) => b.stops.length === 0))).toBe(true);
  });

  it("belongs to the organiser, not to everybody on the trip", async () => {
    // §6.2: contributing finds and re-planning on the road are open to
    // everybody; the frame is the organiser's. A companion adding a
    // city would change the trip out from under the person who booked
    // the hotels.
    const created = await oneLegPlan();
    const email = `mit-${Date.now()}@test.invalid`;
    const [companion] = await db
      .insert(users)
      .values({ email, name: "Mit", password_hash: "x" })
      .returning({ id: users.id });
    await inviteToTrip({ planId: created.id, email });

    vi.mocked(getAuthData).mockReturnValue({
      userID: String(companion.id), permissions: ["photos.view"],
    });

    await expect(addTripLeg({ planId: created.id, title: "Ost", anchor: EAST }))
      .rejects.toThrow(/Etappen ändern/);
    await expect(removeTripLeg({ planId: created.id, legIndex: 0 }))
      .rejects.toThrow(/Etappen ändern/);
    await expect(updateTripLeg({ planId: created.id, legIndex: 0, title: "X" }))
      .rejects.toThrow(/Etappen ändern/);
  });

  it("hides a trip nobody invited you to", async () => {
    // "plan not found" rather than "not allowed": that this trip exists
    // is none of a stranger's business.
    const created = await oneLegPlan();
    const [stranger] = await db
      .insert(users)
      .values({ email: `fremd-${Date.now()}@test.invalid`, name: "Fremd", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(stranger.id), permissions: ["photos.view"],
    });

    await expect(addTripLeg({ planId: created.id, title: "Ost", anchor: EAST }))
      .rejects.toThrow(/plan not found/);
  });
});

describe("PATCH /trip-planner/plans/:planId/legs/:legIndex", () => {
  it("moves the anchor and plans the days again around it", async () => {
    const created = await oneLegPlan();
    const before = stopRefs(created.legs[0]);

    const { plan } = await updateTripLeg({
      planId: created.id, legIndex: 0, anchor: EAST, radiusM: 4_000,
    });

    expect(plan.legs[0].anchor).toEqual(EAST);
    // A different city entirely, so different spots — and the region
    // moved with the anchor.
    expect(plan.legs[0].regionDb).toBe("nom_east");
    expect(stopRefs(plan.legs[0])).not.toEqual(before);
  });

  it("keeps the moved anchor on the next re-plan", async () => {
    // The row carries the anchor; the re-plan writes days. Writing only
    // the days would put the old anchor back the next time.
    const created = await oneLegPlan();
    await updateTripLeg({ planId: created.id, legIndex: 0, anchor: EAST });

    const { plan } = await getTripPlan({ planId: created.id });
    expect(plan.legs[0].anchor).toEqual(EAST);
  });

  it("renames without touching the days", async () => {
    const created = await oneLegPlan();
    const before = stopRefs(created.legs[0]);

    const { plan } = await updateTripLeg({
      planId: created.id, legIndex: 0, title: "Anders benannt",
    });

    expect(plan.legs[0].title).toBe("Anders benannt");
    expect(stopRefs(plan.legs[0])).toEqual(before);
  });

  it("renames a leg somebody has already begun", async () => {
    // A name is not a plan. Refusing it would be a refusal for its own
    // sake, on the one trip that is actually happening.
    const created = await oneLegPlan();
    const stop = created.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    await setTripStopStatus({ planId: created.id, stopId: stop.rowId, status: "done" });

    const { plan } = await updateTripLeg({
      planId: created.id, legIndex: 0, title: "Läuft schon", startDate: "2026-09-17",
    });
    expect(plan.legs[0].title).toBe("Läuft schon");
    expect(plan.legs[0].startDate).toBe("2026-09-17");
  });

  it("refuses to move the anchor under a begun leg", async () => {
    const created = await oneLegPlan();
    const stop = created.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    await setTripStopStatus({ planId: created.id, stopId: stop.rowId, status: "done" });

    await expect(updateTripLeg({ planId: created.id, legIndex: 0, anchor: EAST }))
      .rejects.toThrow(/abgehakt/);
  });

  it("makes a leg longer and shorter", async () => {
    const created = await oneLegPlan();
    expect(created.legs[0].days).toHaveLength(2);

    const longer = await updateTripLeg({ planId: created.id, legIndex: 0, days: 4 });
    expect(longer.plan.legs[0].days).toHaveLength(4);

    const shorter = await updateTripLeg({ planId: created.id, legIndex: 0, days: 1 });
    expect(shorter.plan.legs[0].days).toHaveLength(1);
  });

  it("keeps what somebody added to the pool by hand", async () => {
    // §9.2: a find is somebody's own research, and moving the hotel two
    // streets is not a trade anybody offered for it.
    const created = await oneLegPlan();
    await addFind({
      planId: created.id,
      lat: WEST.lat + 0.02,
      lon: WEST.lon,
      name: "Café Beispielhof",
      note: "beste Pastéis laut Blog",
      dwellMinutes: 30,
    });

    await updateTripLeg({
      planId: created.id, legIndex: 0,
      anchor: { lat: WEST.lat + 0.001, lon: WEST.lon },
    });

    const { plan } = await getTripPlan({ planId: created.id });
    expect(plan.legs[0].pool.some((c) => c.name === "Café Beispielhof")).toBe(true);
  });

  it("names the anchor apart from the city", async () => {
    // One field could not be both: picking a hotel on the map used to
    // name the whole trip after the hotel (§4.2, migration 0169).
    const { plan } = await addTripLeg({
      planId: (await oneLegPlan()).id,
      title: "Oststadt",
      anchor: EAST,
      anchorLabel: "Hotel Beispielhof",
      days: 1,
    });
    expect(plan.legs[1].title).toBe("Oststadt");
    expect(plan.legs[1].anchorLabel).toBe("Hotel Beispielhof");
  });

  it("moves the anchor's name with the anchor", async () => {
    const created = await oneLegPlan();
    const { plan } = await updateTripLeg({
      planId: created.id, legIndex: 0,
      anchor: EAST, anchorLabel: "Pension Musterhof",
    });
    expect(plan.legs[0].anchorLabel).toBe("Pension Musterhof");
    expect(plan.legs[0].title).toBe("Weststadt");
  });

  it("shortens the first day to the arrival, and only the first", async () => {
    const created = await oneLegPlan();
    const before = created.legs[0].days[0].blocks.length;

    const { plan } = await updateTripLeg({
      planId: created.id, legIndex: 0, arriveAt: "14:00",
    });

    expect(plan.legs[0].arriveMinutes).toBe(14 * 60);
    expect(plan.legs[0].days[0].blocks.length).toBeLessThan(before);
    expect(plan.legs[0].days[1].blocks.length).toBe(before);
  });

  it("takes the arrival off again", async () => {
    const created = await oneLegPlan();
    await updateTripLeg({ planId: created.id, legIndex: 0, arriveAt: "14:00" });

    const { plan } = await updateTripLeg({
      planId: created.id, legIndex: 0, arriveAt: null,
    });

    expect(plan.legs[0].arriveMinutes).toBeNull();
    expect(plan.legs[0].days[0].blocks.length)
      .toBe(created.legs[0].days[0].blocks.length);
  });

  it("keeps the arrival when something else is edited", async () => {
    // Moving a hotel two streets does not change when the plane lands.
    const created = await oneLegPlan();
    await updateTripLeg({ planId: created.id, legIndex: 0, arriveAt: "14:00" });

    const { plan } = await updateTripLeg({
      planId: created.id, legIndex: 0,
      anchor: { lat: WEST.lat + 0.001, lon: WEST.lon },
    });

    expect(plan.legs[0].arriveMinutes).toBe(14 * 60);
  });

  it("refuses an arrival that is not a time", async () => {
    const created = await oneLegPlan();
    await expect(updateTripLeg({ planId: created.id, legIndex: 0, arriveAt: "nachmittags" }))
      .rejects.toThrow(/HH:MM/);
    await expect(updateTripLeg({ planId: created.id, legIndex: 0, arriveAt: "25:00" }))
      .rejects.toThrow(/HH:MM/);
  });

  it("says which leg it cannot find", async () => {
    const created = await oneLegPlan();
    await expect(updateTripLeg({ planId: created.id, legIndex: 7, title: "X" }))
      .rejects.toThrow(/leg 7/);
  });
});

describe("DELETE /trip-planner/plans/:planId/legs/:legIndex", () => {
  it("removes a leg and closes the gap", async () => {
    const created = await oneLegPlan();
    await addTripLeg({ planId: created.id, title: "Mitte", anchor: EAST, days: 1 });
    await addTripLeg({ planId: created.id, title: "Ende", anchor: EAST, days: 1 });

    const { plan } = await removeTripLeg({ planId: created.id, legIndex: 1 });

    expect(plan.legs.map((l) => l.title)).toEqual(["Weststadt", "Ende"]);
    expect(plan.legs.map((l) => l.position)).toEqual([0, 1]);
  });

  it("refuses to remove the only leg", async () => {
    // A trip with no legs is not a trip. Deleting the whole thing is a
    // different gesture, in a different place, and it says so.
    const created = await oneLegPlan();
    await expect(removeTripLeg({ planId: created.id, legIndex: 0 }))
      .rejects.toThrow(/einzige Etappe/);
  });

  it("refuses to remove a leg somebody has begun", async () => {
    const created = await oneLegPlan();
    await addTripLeg({ planId: created.id, title: "Ost", anchor: EAST, days: 1 });
    const stop = created.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    await setTripStopStatus({ planId: created.id, stopId: stop.rowId, status: "done" });

    await expect(removeTripLeg({ planId: created.id, legIndex: 0 }))
      .rejects.toThrow(/abgehakt/);
  });
});
