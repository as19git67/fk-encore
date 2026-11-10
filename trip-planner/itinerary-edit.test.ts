/**
 * Changing a trip through its chain (documentation/plans/reiseverlauf.md,
 * stage 4): what `POST /legs`, `PATCH /legs/:i`, `DELETE /legs/:i`,
 * `POST /transits` and `PATCH /transits/:i` used to do, done by writing
 * the whole itinerary — adding a stay, moving a hotel, giving a journey
 * its times, the way there and the way home, a cruise.
 *
 * Each of these can go quietly wrong in a way the response still looks
 * fine for: a stay that silently reuses the wrong region, a journey
 * that frames only one of its two ends, a renumbering that makes
 * "leg 2" mean two things.
 *
 * Coordinates sit near a river town in Bavaria; every place is invented.
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

import { createTripPlan, detailTripDay, getTripPlan, setTripStopStatus } from "./plans";
import { removeTripFixpoint } from "./fixpoint-edit";
import { getUserHome, setTripHome, setUserHomeEndpoint } from "./home";
import { applyVotesToPlan, castVote } from "./plan-votes";
import { inviteToTrip } from "./shares";
import { addFind } from "./add-find";
import { getTripItinerary, putTripItinerary, type ItineraryItem } from "./itinerary";
import { planJournal, undoPlanOp } from "./plan-ops";

const ANCHOR = { lat: 48.37, lon: 10.9 };
const NEXT = { lat: 48.37, lon: 11.4 };
const LATER = { lat: 48.37, lon: 11.45 };
// Inside the western region too, a good way west of the first place.
const HOME = { lat: 48.5, lon: 10.55 };
// A second region further east, so a stay added there has to find it.
const EAST = { lat: 48.37, lon: 11.9 };
const WEST_DB = "nom_west";
const EAST_DB = "nom_east";

function spot(n: number, lat: number, lon: number): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat,
    lon,
    distanceM: 400,
    detourM: 800,
    name: `Sehenswürdigkeit ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: "Q1",
    wikipedia: "de:Beispiel",
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
    .values({ email: `chain-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = user.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(ownerId),
    permissions: ["photos.view"],
  });
  await seedRegion("europe/west", WEST_DB, [48.2, 10.5, 48.6, 11.6]);
  await seedRegion("europe/east", EAST_DB, [48.2, 11.7, 48.6, 12.2]);
  geo = new InMemoryGeoClient();
  geo.setSearchSpots(WEST_DB, [
    // Around the first base, around the second, and one on the way.
    spot(1, ANCHOR.lat + 0.003, ANCHOR.lon), spot(2, ANCHOR.lat - 0.003, ANCHOR.lon),
    spot(3, ANCHOR.lat, ANCHOR.lon + 0.25),
    spot(4, NEXT.lat + 0.003, NEXT.lon), spot(5, NEXT.lat - 0.003, NEXT.lon),
    spot(6, LATER.lat + 0.003, LATER.lon),
  ]);
  // The eastern ids start at 101, so a stay planned against the wrong
  // region is visible in the refs rather than only in a database name.
  geo.setSearchSpots(EAST_DB, Array.from({ length: 8 }, (_, i) =>
    spot(101 + i, EAST.lat + (i + 1) * 0.0005, EAST.lon)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

// MARK: - Helpers

/** The chain as the app holds it, every item its own copy. */
async function chainOf(planId: number) {
  const chain = await getTripItinerary({ planId });
  return { startDate: chain.startDate, items: chain.items.map((i) => ({ ...i }) as ItineraryItem) };
}

async function write(planId: number, chain: { startDate: string | null; items: ItineraryItem[] }) {
  return putTripItinerary({ planId, startDate: chain.startDate, items: chain.items });
}

/** Index in the chain of the stay number `n` (0-based). */
function stayAt(items: ItineraryItem[], n: number): number {
  return items.flatMap((item, index) => (item.kind === "stay" ? [index] : []))[n];
}

/**
 * Give the journey after stay `afterStay` its times, or the way there
 * for -1 — the gesture the app makes on a journey card — and write.
 */
async function addJourney(
  planId: number,
  afterStay: number,
  journey: { departAt: string; arriveAt: string; nights?: number; mode?: ItineraryItem["mode"] },
) {
  const chain = await chainOf(planId);
  if (afterStay === -1) {
    if (chain.items[0].kind === "journey") Object.assign(chain.items[0], { nights: 0, ...journey });
    else chain.items.unshift({ kind: "journey", ...journey });
  } else {
    const index = stayAt(chain.items, afterStay) + 1;
    if (chain.items[index]?.kind === "journey") Object.assign(chain.items[index], { nights: 0, ...journey });
    else chain.items.splice(index, 0, { kind: "journey", ...journey });
  }
  return write(planId, chain);
}

/** Change the stay number `n` and write the chain. */
async function editStay(planId: number, n: number, change: Partial<ItineraryItem>) {
  const chain = await chainOf(planId);
  Object.assign(chain.items[stayAt(chain.items, n)], change);
  return write(planId, chain);
}

async function threeStays() {
  const { plan } = await createTripPlan({
    legs: [
      { title: "Erster Ort", anchor: ANCHOR, anchorLabel: "Hotel am Fluss", days: 2, startDate: "2026-09-05", mode: "car" },
      { title: "Zweiter Ort", anchor: NEXT, anchorLabel: "Pension am See", days: 2, startDate: "2026-09-07", mode: "car" },
      { title: "Dritter Ort", anchor: LATER, days: 1, startDate: "2026-09-10", mode: "car" },
    ],
  });
  return plan;
}

async function oneStay(over: Record<string, unknown> = {}) {
  const { plan } = await createTripPlan({
    title: "Erstmal ein Ort",
    legs: [{ title: "Westort", anchor: ANCHOR, days: 2, radiusM: 4_000 }],
    ...over,
  });
  return plan;
}

const stopRefs = (leg: { days: { blocks: { stops: { osmRef: string }[] }[] }[] }) =>
  leg.days.flatMap((d) => d.blocks.flatMap((b) => b.stops.map((s) => s.osmRef)));

const departureOf = (leg: { days: { fixpoints: { kind: string }[] }[] }) =>
  leg.days.at(-1)!.fixpoints.find((f) => f.kind === "departure");

// MARK: - Journeys

describe("a journey with both times is a leg of its own", () => {
  it("puts the journey between two stays and frames both neighbours by it", async () => {
    const plan = await threeStays();

    const { plan: after } = await addJourney(plan.id, 0, { departAt: "10:00", arriveAt: "16:00" });

    expect(after.legs.map((l) => [l.position, l.kind, l.title])).toEqual([
      [0, "stay", "Erster Ort"],
      [1, "transit", "Weiterreise nach Zweiter Ort"],
      [2, "stay", "Zweiter Ort"],
      [3, "stay", "Dritter Ort"],
    ]);
    const [left, journey, reached, later] = after.legs;

    // The stay being left ends on the day of departure, with it.
    expect(left.days).toHaveLength(2);
    expect(departureOf(left)).toMatchObject({ startMinutes: 600, label: "Weiterreise nach Zweiter Ort" });

    // The journey: from the one base to the other, on one day.
    expect(journey).toMatchObject({
      startDate: "2026-09-06", departMinutes: 600, endMinutes: 960, mode: "car",
      anchor: NEXT, origin: { lat: ANCHOR.lat, lon: ANCHOR.lon, label: "Hotel am Fluss" },
    });
    expect(journey.days).toHaveLength(1);
    const [block] = journey.days[0].blocks;
    expect(block).toMatchObject({ id: "transit", label: "Unterwegs", budgetMinutes: 360, startMinutes: 600 });
    // Stops go in, in the direction of travel: the day walks from the
    // one base towards the other, not back and forth.
    expect(block.stops.length).toBeGreaterThan(0);
    const lons = block.stops.map((s) => s.lon);
    expect(lons).toEqual([...lons].sort((a, b) => a - b));
    // The place on the way is either planned or waiting in the journey's
    // own pool — the corridor, not a radius around one base.
    const known = [...block.stops.map((s) => s.osmRef), ...journey.pool.map((c) => c.osmRef)];
    expect(known).toContain("node:3");
    expect(journey.days[0].fixpoints.map((f) => f.label))
      .toEqual(["Abfahrt Hotel am Fluss", "Ankunft Pension am See"]);

    // The stay reached begins on the day of arrival, at the arrival —
    // a day earlier than before — and every stay after it moves along.
    expect(reached.startDate).toBe("2026-09-06");
    expect(reached.arriveMinutes).toBe(960);
    expect(later.startDate).toBe("2026-09-09");
  });

  it("frames a journey by train without planning into it", async () => {
    const plan = await threeStays();
    const { plan: after } = await addJourney(plan.id, 0, { departAt: "10:00", arriveAt: "16:00", mode: "transit" });
    const day = after.legs[1].days[0];
    expect(day.detailed).toBe(false);
    expect(day.bufferReason).toBe("Unterwegs mit Bahn oder Bus");
    expect(day.blocks.flatMap((b) => b.stops)).toEqual([]);
  });

  it("changes the journey in place and moves the neighbours with it", async () => {
    const plan = await threeStays();
    const { plan: before } = await addJourney(plan.id, 0, { departAt: "10:00", arriveAt: "16:00" });
    const journey = before.legs[1];

    // Leaving an hour later and arriving the next morning.
    const { plan: after } = await addJourney(plan.id, 0, { departAt: "11:00", arriveAt: "09:00", nights: 1 });

    // The same journey — its row, its place, its name — with new moments.
    const changed = after.legs[1];
    expect(changed).toMatchObject({
      id: journey.id, kind: "transit", title: journey.title,
      startDate: "2026-09-06", departMinutes: 660, endMinutes: 540,
    });
    expect(changed.days).toHaveLength(2);
    // Over night: a frame without stops.
    expect(changed.days.every((d) => !d.detailed)).toBe(true);

    // The stay left now departs at eleven.
    expect(departureOf(after.legs[0])?.startMinutes).toBe(660);
    // The stay reached begins the next day at nine; the one after moves too.
    expect(after.legs[2]).toMatchObject({ startDate: "2026-09-07", arriveMinutes: 540 });
    expect(after.legs[3].startDate).toBe("2026-09-10");
  });

  it("changes how the journey travels", async () => {
    const plan = await threeStays();
    await addJourney(plan.id, 0, { departAt: "10:00", arriveAt: "16:00" });
    const { plan: after } = await addJourney(plan.id, 0, { departAt: "10:00", arriveAt: "16:00", mode: "transit" });
    expect(after.legs[1].mode).toBe("transit");
    expect(after.legs[1].days[0].bufferReason).toBe("Unterwegs mit Bahn oder Bus");
  });

  it("refuses what cannot be a journey, and leaves the journey as it was when refusing", async () => {
    const plan = await threeStays();
    await addJourney(plan.id, 0, { departAt: "10:00", arriveAt: "16:00" });

    await expect(addJourney(plan.id, 0, { departAt: "16:00", arriveAt: "10:00" }))
      .rejects.toMatchObject({ code: "invalid_argument" });
    const chain = await chainOf(plan.id);
    chain.items.splice(1, 0, { kind: "journey", departAt: "08:00", arriveAt: "09:00" });
    await expect(write(plan.id, chain)).rejects.toMatchObject({ code: "invalid_argument" });

    const { plan: still } = await getTripPlan({ planId: plan.id });
    expect(still.legs[1]).toMatchObject({ kind: "transit", departMinutes: 600, endMinutes: 960 });
  });

  it("keeps the journey's own departure and arrival where they are", async () => {
    const plan = await threeStays();
    const { plan: after } = await addJourney(plan.id, 0, { departAt: "10:00", arriveAt: "16:00" });
    const journey = after.legs[1];
    const arrival = journey.days.at(-1)!.fixpoints.find((f) => f.kind === "departure")!;
    const departure = journey.days[0].fixpoints.find((f) => f.kind === "appointment")!;
    // The re-plan would write them straight back, so the call says so
    // instead of pretending.
    await expect(removeTripFixpoint({ planId: plan.id, fixpointId: arrival.rowId }))
      .rejects.toMatchObject({ code: "failed_precondition" });
    await expect(removeTripFixpoint({ planId: plan.id, fixpointId: departure.rowId }))
      .rejects.toMatchObject({ code: "failed_precondition" });
    const { plan: still } = await getTripPlan({ planId: plan.id });
    expect(still.legs[1].days.at(-1)!.fixpoints.map((f) => f.label)).toContain(arrival.label);
  });

  it("plans nothing into a journey's day that is only a frame", async () => {
    const plan = await threeStays();
    // Over night: two days, neither of them plannable.
    const { plan: after } = await addJourney(plan.id, 0, { departAt: "18:00", arriveAt: "08:00", nights: 1 });
    expect(after.legs[1].days.every((d) => !d.detailed)).toBe(true);
    await expect(detailTripDay({ planId: plan.id, legIndex: 1, dayIndex: 1 }))
      .rejects.toMatchObject({ code: "failed_precondition" });
  });
});

// MARK: - Home

describe("the way there and the way home", () => {
  it("needs a home, and forgets it again", async () => {
    const plan = await threeStays();
    await expect(addJourney(plan.id, -1, { departAt: "08:00", arriveAt: "12:00" }))
      .rejects.toMatchObject({ code: "invalid_argument", message: expect.stringMatching(/Zuhause/) });

    const { plan: withHome } = await setTripHome({ planId: plan.id, ...HOME, label: "Zuhause" });
    expect(withHome.home).toEqual({ ...HOME, label: "Zuhause" });
    const { plan: without } = await setTripHome({ planId: plan.id, clear: true });
    expect(without.home).toBeNull();
    await expect(setTripHome({ planId: plan.id, lat: 95, lon: 0 }))
      .rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("starts a new trip with the home its owner set once", async () => {
    expect((await getUserHome()).home).toBeNull();
    const { home } = await setUserHomeEndpoint({ ...HOME, label: "Daheim" });
    expect(home).toEqual({ ...HOME, label: "Daheim" });

    const { plan } = await createTripPlan({ legs: [{ anchor: ANCHOR, days: 1 }] });
    expect(plan.home).toEqual({ ...HOME, label: "Daheim" });

    // A trip may still have a home of its own, and forgetting the
    // person's home moves no trip.
    const { plan: own } = await setTripHome({ planId: plan.id, lat: 48.45, lon: 10.6, label: "Ferienhaus" });
    expect(own.home).toEqual({ lat: 48.45, lon: 10.6, label: "Ferienhaus" });
    expect((await setUserHomeEndpoint({ clear: true })).home).toBeNull();
    const { plan: still } = await createTripPlan({ legs: [{ anchor: ANCHOR, days: 1 }] });
    expect(still.home).toBeNull();
  });

  it("takes the first home given to a trip as the person's, until they say otherwise", async () => {
    const { plan } = await createTripPlan({ legs: [{ anchor: ANCHOR, days: 1 }] });
    await setTripHome({ planId: plan.id, ...HOME, label: "Zuhause" });
    expect((await getUserHome()).home).toEqual({ ...HOME, label: "Zuhause" });
    // Another trip's home does not replace it.
    await setTripHome({ planId: plan.id, lat: 48.45, lon: 10.6, label: "Ferienhaus" });
    expect((await getUserHome()).home).toEqual({ ...HOME, label: "Zuhause" });
  });

  it("puts the journey from home in front, framed by the first place's arrival", async () => {
    const plan = await threeStays();
    await setTripHome({ planId: plan.id, ...HOME, label: "Zuhause" });

    const { plan: after } = await addJourney(plan.id, -1, { departAt: "08:00", arriveAt: "12:00" });

    expect(after.legs.map((l) => [l.position, l.kind, l.title])).toEqual([
      [0, "transit", "Anreise nach Erster Ort"],
      [1, "stay", "Erster Ort"],
      [2, "stay", "Zweiter Ort"],
      [3, "stay", "Dritter Ort"],
    ]);
    const [journey, first] = after.legs;
    expect(journey).toMatchObject({
      origin: { ...HOME, label: "Zuhause" }, anchor: ANCHOR, departMinutes: 480, endMinutes: 720,
      startDate: "2026-09-05",
    });
    expect(journey.days[0].fixpoints.map((f) => f.label)).toEqual(["Abfahrt Zuhause", "Ankunft Hotel am Fluss"]);
    // The first place begins at the arrival; the other places stay put.
    expect(first).toMatchObject({ startDate: "2026-09-05", arriveMinutes: 720 });
    expect(after.legs[2].startDate).toBe("2026-09-07");
  });

  it("appends the journey home, ending the last place with the departure", async () => {
    const plan = await threeStays();
    await setTripHome({ planId: plan.id, ...HOME, label: "Zuhause" });

    const { plan: after } = await addJourney(plan.id, 2, { departAt: "10:00", arriveAt: "15:00" });

    const journey = after.legs[3];
    expect(journey).toMatchObject({
      kind: "transit", title: "Heimreise von Dritter Ort", anchor: HOME, anchorLabel: "Zuhause",
      origin: { lat: LATER.lat, lon: LATER.lon }, startDate: "2026-09-10",
    });
    expect(departureOf(after.legs[2])).toMatchObject({ startMinutes: 600, label: "Weiterreise nach Zuhause" });

    // And it can be changed in place like any journey.
    const { plan: changed } = await addJourney(plan.id, 2, { departAt: "14:00", arriveAt: "19:00" });
    expect(changed.legs[3]).toMatchObject({ id: journey.id, departMinutes: 840, endMinutes: 1140 });
  });
});

describe("voting on the way", () => {
  it("lets the group turn a stop on the journey down, and the next plan leaves it out", async () => {
    const plan = await threeStays();
    const { plan: after } = await addJourney(plan.id, 0, { departAt: "10:00", arriveAt: "16:00" });
    const journey = after.legs[1];
    const stop = journey.days[0].blocks[0].stops[0];
    expect(stop).toBeDefined();

    // "lieber nicht" on a stop of the journey (§6.1) — the ballot works
    // per leg, and a journey is a leg.
    await castVote({ planId: plan.id, legIndex: 1, osmRef: stop.osmRef, value: "rather-not" });
    const { plan: voted } = await applyVotesToPlan({ planId: plan.id });

    const stops = voted.legs[1].days[0].blocks.flatMap((b) => b.stops.map((s) => s.osmRef));
    expect(stops).not.toContain(stop.osmRef);
    expect(voted.legs[1].kind).toBe("transit");
  });
});

// MARK: - Aboard

describe("the quarters travel along (§21.3)", () => {
  async function twoPorts() {
    const { plan } = await createTripPlan({
      legs: [
        { title: "Erster Hafen", anchor: ANCHOR, anchorLabel: "Liegeplatz 3", days: 1, startDate: "2026-09-05",
          mode: "foot", quartersAboard: true },
        { title: "Zweiter Hafen", anchor: NEXT, anchorLabel: "Pier 1", days: 1, startDate: "2026-09-07",
          mode: "foot", quartersAboard: true, tenderPort: true },
      ],
    });
    return plan;
  }

  it("keeps the property on the leg", async () => {
    const plan = await twoPorts();
    expect(plan.legs.map((l) => [l.quartersAboard, l.tenderPort])).toEqual([[true, false], [true, true]]);
  });

  it("lets a ship journey carry the sea days of a cruise, and keeps the week's limit for everything else", async () => {
    const plan = await twoPorts();
    const { plan: after } = await addJourney(plan.id, 0, { departAt: "18:00", arriveAt: "08:00", nights: 12, mode: "ship" });
    expect(after.legs[1].days).toHaveLength(13);
    await expect(addJourney(plan.id, 0, { departAt: "18:00", arriveAt: "08:00", nights: 31, mode: "ship" }))
      .rejects.toMatchObject({ code: "invalid_argument" });
    await expect(addJourney(plan.id, 0, { departAt: "18:00", arriveAt: "08:00", nights: 7, mode: "car" }))
      .rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("ends a port day with 'Alle an Bord' and an hour in hand, and calls the sea a day aboard", async () => {
    const plan = await twoPorts();
    const { plan: after } = await addJourney(plan.id, 0, { departAt: "17:00", arriveAt: "08:00", nights: 2, mode: "ship" });
    const [port, sea, nextPort] = after.legs;
    expect(sea.title).toBe("An Bord nach Zweiter Hafen");
    expect(sea.mode).toBe("ship");
    expect(sea.days).toHaveLength(3);
    expect(sea.days.map((d) => d.bufferReason)).toEqual(["An Bord", "An Bord", "An Bord"]);
    expect(sea.days.flatMap((d) => d.blocks.flatMap((b) => b.stops))).toEqual([]);

    expect(departureOf(port)).toMatchObject({ label: "Alle an Bord", startMinutes: 1020, bufferMinutes: 60 });
    expect(nextPort.startDate).toBe("2026-09-07");
    expect(nextPort.arriveMinutes).toBe(480);
  });

  it("puts a port between two ship journeys aboard without being told, with a day from arrival to departure", async () => {
    const plan = await threeStays();
    const chain = await chainOf(plan.id);
    Object.assign(chain.items[stayAt(chain.items, 1)], { days: 1 });
    Object.assign(chain.items[1], { departAt: "18:00", arriveAt: "06:00", nights: 1, mode: "ship" });
    Object.assign(chain.items[3], { departAt: "21:00", arriveAt: "08:00", nights: 1, mode: "ship" });
    const { plan: after } = await write(plan.id, chain);

    const port = after.legs.find((l) => l.title === "Zweiter Ort")!;
    expect(port.quartersAboard).toBe(true);
    expect(port.days).toHaveLength(1);
    expect(port.startDate).toBe("2026-09-07");
    expect(port.arriveMinutes).toBe(360);
    expect(departureOf(port)).toMatchObject({ label: "Alle an Bord", startMinutes: 1260, bufferMinutes: 60 });

    const read = await getTripItinerary({ planId: plan.id });
    expect(read.items[2]).toMatchObject({ kind: "stay", quartersAboard: true, days: 1,
      startDate: "2026-09-07", endDate: "2026-09-07" });
  });

  it("adds a port into a ship journey and keeps the end of the trip, or names the port that would move it", async () => {
    const plan = await twoPorts();
    await addJourney(plan.id, 0, { departAt: "18:00", arriveAt: "08:00", nights: 4, mode: "ship" });
    const before = await getTripItinerary({ planId: plan.id });
    expect(before.items.at(-1)?.endDate).toBe("2026-09-09");

    const port = (seaAfter: number) => {
      const items = before.items.map((i) => ({ ...i }) as ItineraryItem);
      const sea = items[1];
      items.splice(1, 1,
        { ...sea, legId: undefined, nights: 1, arriveAt: "07:00" },
        { kind: "stay", title: "Neuer Hafen", anchor: LATER, days: 2, mode: "foot" },
        { ...sea, legId: undefined, departAt: "20:00", nights: seaAfter });
      return { startDate: before.startDate, items };
    };

    await expect(write(plan.id, port(3))).rejects.toThrow(/„Neuer Hafen“ verschiebt das Ende der Reise vom 9\.9\.2026 auf den 10\.9\.2026/);

    await write(plan.id, port(2));
    const after = await getTripItinerary({ planId: plan.id });
    expect(after.items.at(-1)?.endDate).toBe("2026-09-09");
    expect(after.items[2]).toMatchObject({ title: "Neuer Hafen", quartersAboard: true,
      startDate: "2026-09-06", endDate: "2026-09-07" });
  });

  it("gives a tender port the boat ride back on top", async () => {
    const plan = await twoPorts();
    await setTripHome({ planId: plan.id, lat: HOME.lat, lon: HOME.lon, label: "Zuhause" });
    const { plan: after } = await addJourney(plan.id, 1, { departAt: "18:00", arriveAt: "09:00", nights: 1, mode: "ship" });
    expect(departureOf(after.legs[1])).toMatchObject({ label: "Alle an Bord", bufferMinutes: 90 });
  });

  it("rewrites the departure when the property changes after the journey was made", async () => {
    const plan = await threeStays();
    await addJourney(plan.id, 0, { departAt: "17:00", arriveAt: "08:00", nights: 1, mode: "ship" });
    // A hotel until somebody says otherwise: the train's margin.
    let { plan: current } = await getTripPlan({ planId: plan.id });
    expect(departureOf(current.legs[0])).toMatchObject({ label: "Weiterreise nach Zweiter Ort", bufferMinutes: 20 });

    ({ plan: current } = await editStay(plan.id, 0, { quartersAboard: true }));
    expect(current.legs[0].quartersAboard).toBe(true);
    expect(departureOf(current.legs[0])).toMatchObject({ label: "Alle an Bord", bufferMinutes: 60, startMinutes: 1020 });

    ({ plan: current } = await editStay(plan.id, 0, { tenderPort: true }));
    expect(departureOf(current.legs[0])).toMatchObject({ label: "Alle an Bord", bufferMinutes: 90 });

    ({ plan: current } = await editStay(plan.id, 0, { quartersAboard: false }));
    expect(departureOf(current.legs[0])).toMatchObject({ label: "Weiterreise nach Zweiter Ort", bufferMinutes: 20 });
  });

  it("only keeps the property while no journey leaves the leg", async () => {
    const plan = await threeStays();
    const { plan: after } = await editStay(plan.id, 2, { quartersAboard: true, tenderPort: true });
    expect(after.legs[2]).toMatchObject({ quartersAboard: true, tenderPort: true });
    expect(after.legs[2].days[0].fixpoints.filter((f) => f.kind === "departure")).toEqual([]);
  });
});

// MARK: - Stays

describe("adding a stay", () => {
  const eastStay = (over: Partial<ItineraryItem> = {}): ItineraryItem =>
    ({ kind: "stay", title: "Ostort", anchor: EAST, days: 2, radiusM: 4_000, mode: "foot", ...over });

  async function appendStay(planId: number, stay: ItineraryItem) {
    const chain = await chainOf(planId);
    chain.items.push({ kind: "journey" }, stay);
    return write(planId, chain);
  }

  it("adds a stay with its own region, anchor and pool", async () => {
    const created = await oneStay();

    const { plan } = await appendStay(created.id, eastStay());

    expect(plan.legs).toHaveLength(2);
    expect(plan.legs[1].title).toBe("Ostort");
    expect(plan.legs[1].regionDb).toBe(EAST_DB);
    // Its own search, around its own anchor — a stay quietly reusing the
    // first one's region would look perfectly fine in the response.
    expect(geo.getSearchCalls().map((c) => c.postgresDb)).toContain(EAST_DB);
    // And what it planned really is from over there: every ref in the
    // new stay carries the eastern id range.
    const refs = stopRefs(plan.legs[1]);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((ref) => Number(ref.split(":")[1]) > 100)).toBe(true);
    // And the first stay is untouched.
    expect(stopRefs(plan.legs[0])).toEqual(stopRefs(created.legs[0]));
  });

  it("plans the new stay with the trip's settings, not with defaults", async () => {
    // A stay added on Tuesday has to come out like one named at the
    // start: same pace, same block budgets.
    const relaxed = await oneStay({ pace: "relaxed" });
    const packed = await oneStay({ title: "Zügig", pace: "packed" });

    const a = await appendStay(relaxed.id, eastStay({ days: 1 }));
    const b = await appendStay(packed.id, eastStay({ days: 1 }));

    const budget = (p: typeof a.plan) =>
      p.legs[1].days[0].blocks.reduce((n, blk) => n + blk.budgetMinutes, 0);
    expect(budget(a.plan)).toBeLessThan(budget(b.plan));
  });

  it("puts a stay in the middle and renumbers the rest", async () => {
    const created = await oneStay();
    await appendStay(created.id, eastStay({ title: "Zuletzt", days: 1 }));

    const chain = await chainOf(created.id);
    chain.items.splice(1, 0, { kind: "journey" }, eastStay({ title: "Dazwischen", days: 1 }));
    const { plan } = await write(created.id, chain);

    expect(plan.legs.map((l) => l.title)).toEqual(["Westort", "Dazwischen", "Zuletzt"]);
    // Positions are what every endpoint addresses a leg by, so a hole
    // in the sequence would make "leg 2" mean two different things.
    expect(plan.legs.map((l) => l.position)).toEqual([0, 1, 2]);
  });

  it("saves a stay whose region is not imported yet, and says so", async () => {
    // §4.3: framed but not filled in. Refusing would throw away
    // everything the traveller typed for a download they cannot start.
    const created = await oneStay();

    const response = await appendStay(created.id, eastStay({ title: "Weit weg", anchor: { lat: 38.71, lon: -9.14 } }));

    expect(response.plan.legs).toHaveLength(2);
    expect(response.pendingRegions?.[0]?.legIndex).toBe(1);
    expect(response.plan.legs[1].days).toHaveLength(2);
    expect(response.plan.legs[1].days.every((d) => d.blocks.every((b) => b.stops.length === 0))).toBe(true);
  });

  it("belongs to the organiser, not to everybody on the trip", async () => {
    // §6.2: contributing finds and re-planning on the road are open to
    // everybody; the frame is the organiser's. A companion adding a
    // stay would change the trip out from under the person who booked
    // the hotels.
    const created = await oneStay();
    const email = `mit-${crypto.randomUUID()}@test.invalid`;
    const [companion] = await db
      .insert(users)
      .values({ email, name: "Mit", password_hash: "x" })
      .returning({ id: users.id });
    await inviteToTrip({ planId: created.id, email });

    vi.mocked(getAuthData).mockReturnValue({
      userID: String(companion.id), permissions: ["photos.view"],
    });

    await expect(appendStay(created.id, eastStay())).rejects.toThrow(/Reiseverlauf/);
    const chain = await chainOf(created.id);
    await expect(write(created.id, chain)).rejects.toThrow(/Reiseverlauf/);
  });

  it("hides a trip nobody invited you to", async () => {
    // "plan not found" rather than "not allowed": that this trip exists
    // is none of a stranger's business.
    const created = await oneStay();
    const [stranger] = await db
      .insert(users)
      .values({ email: `fremd-${crypto.randomUUID()}@test.invalid`, name: "Fremd", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(stranger.id), permissions: ["photos.view"],
    });

    await expect(getTripItinerary({ planId: created.id })).rejects.toThrow(/plan not found/);
  });
});

describe("changing a stay", () => {
  it("moves the anchor and plans the days again around it", async () => {
    const created = await oneStay();
    const before = stopRefs(created.legs[0]);

    const { plan } = await editStay(created.id, 0, { anchor: EAST, radiusM: 4_000 });

    expect(plan.legs[0].anchor).toEqual(EAST);
    // A different town entirely, so different spots — and the region
    // moved with the anchor.
    expect(plan.legs[0].regionDb).toBe(EAST_DB);
    expect(stopRefs(plan.legs[0])).not.toEqual(before);
    // The row carries the anchor; the re-plan writes days. Writing only
    // the days would put the old anchor back the next time.
    const { plan: again } = await getTripPlan({ planId: created.id });
    expect(again.legs[0].anchor).toEqual(EAST);
  });

  it("renames without touching the days", async () => {
    const created = await oneStay();
    const before = stopRefs(created.legs[0]);

    const { plan } = await editStay(created.id, 0, { title: "Anders benannt" });

    expect(plan.legs[0].title).toBe("Anders benannt");
    expect(stopRefs(plan.legs[0])).toEqual(before);
  });

  it("renames and dates a stay somebody has already begun", async () => {
    // A name is not a plan. Refusing it would be a refusal for its own
    // sake, on the one trip that is actually happening.
    const created = await oneStay();
    const stop = created.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    await setTripStopStatus({ planId: created.id, stopId: stop.rowId, status: "done" });

    const chain = await chainOf(created.id);
    chain.items[0].title = "Läuft schon";
    chain.startDate = "2026-09-17";
    const { plan } = await write(created.id, chain);
    expect(plan.legs[0].title).toBe("Läuft schon");
    expect(plan.legs[0].startDate).toBe("2026-09-17");
  });

  it("refuses to move the anchor under a begun stay", async () => {
    const created = await oneStay();
    const stop = created.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    await setTripStopStatus({ planId: created.id, stopId: stop.rowId, status: "done" });

    await expect(editStay(created.id, 0, { anchor: EAST })).rejects.toThrow(/abgehakt/);
  });

  it("makes a stay longer and shorter", async () => {
    const created = await oneStay();
    expect(created.legs[0].days).toHaveLength(2);

    const longer = await editStay(created.id, 0, { days: 4 });
    expect(longer.plan.legs[0].days).toHaveLength(4);

    const shorter = await editStay(created.id, 0, { days: 1 });
    expect(shorter.plan.legs[0].days).toHaveLength(1);
  });

  it("keeps what somebody added to the pool by hand", async () => {
    // §9.2: a find is somebody's own research, and moving the hotel two
    // streets is not a trade anybody offered for it.
    const created = await oneStay();
    await addFind({
      planId: created.id,
      lat: ANCHOR.lat + 0.02,
      lon: ANCHOR.lon,
      name: "Café Beispielhof",
      note: "beste Pastéis laut Blog",
      dwellMinutes: 30,
    });

    await editStay(created.id, 0, { anchor: { lat: ANCHOR.lat + 0.001, lon: ANCHOR.lon } });

    const { plan } = await getTripPlan({ planId: created.id });
    expect(plan.legs[0].pool.some((c) => c.name === "Café Beispielhof")).toBe(true);
  });

  it("moves the anchor's name with the anchor, and keeps it apart from the stay's", async () => {
    // One field could not be both: picking a hotel on the map used to
    // name the whole trip after the hotel (§4.2, migration 0169).
    const created = await oneStay();
    const { plan } = await editStay(created.id, 0, { anchor: EAST, anchorLabel: "Pension Musterhof" });
    expect(plan.legs[0].anchorLabel).toBe("Pension Musterhof");
    expect(plan.legs[0].title).toBe("Westort");
  });

  it("shortens the first day to the arrival, and only the first — and takes it off again", async () => {
    const created = await oneStay();
    const before = created.legs[0].days[0].blocks.length;

    const { plan } = await editStay(created.id, 0, { arriveAt: "14:00" });
    expect(plan.legs[0].arriveMinutes).toBe(14 * 60);
    expect(plan.legs[0].days[0].blocks.length).toBeLessThan(before);
    expect(plan.legs[0].days[1].blocks.length).toBe(before);

    // Moving a hotel two streets does not change when the plane lands:
    // the chain reads the arrival back and writes it again.
    const { plan: moved } = await editStay(created.id, 0, { anchor: { lat: ANCHOR.lat + 0.001, lon: ANCHOR.lon } });
    expect(moved.legs[0].arriveMinutes).toBe(14 * 60);

    const { plan: off } = await editStay(created.id, 0, { arriveAt: null });
    expect(off.legs[0].arriveMinutes).toBeNull();
    expect(off.legs[0].days[0].blocks.length).toBe(before);
  });

  it("refuses an arrival that is not a time", async () => {
    const created = await oneStay();
    await expect(editStay(created.id, 0, { arriveAt: "nachmittags" })).rejects.toThrow(/HH:MM/);
    await expect(editStay(created.id, 0, { arriveAt: "25:00" })).rejects.toThrow(/HH:MM/);
  });

  it("refuses a chain without a stay", async () => {
    // A trip with no stay is not a trip. Deleting the whole thing is a
    // different gesture, in a different place.
    const created = await oneStay();
    await expect(putTripItinerary({ planId: created.id, startDate: null, items: [] }))
      .rejects.toThrow(/Aufenthalt/);
  });
});

describe("taking a change of the itinerary back", () => {
  const itineraryRows = async (planId: number) =>
    (await planJournal({ planId })).entries.filter((e) => e.kind === "itinerary");

  /** A first stay, then a second one in the east, both with planned stops. */
  async function twoStays() {
    const created = await oneStay();
    const chain = await chainOf(created.id);
    chain.items.push({ kind: "journey" }, { kind: "stay", title: "Ostort", anchor: EAST, days: 2, radiusM: 4_000, mode: "foot" });
    const { plan } = await write(created.id, chain);
    return plan;
  }

  it("journals a change that shortens planned days, and the undo brings the same days back", async () => {
    const created = await oneStay();
    const leg = created.legs[0];
    const refsBefore = stopRefs(leg);
    expect(refsBefore.length).toBeGreaterThan(0);
    expect(leg.days).toHaveLength(2);

    const { plan: shorter } = await editStay(created.id, 0, { days: 1 });
    expect(shorter.legs[0].days).toHaveLength(1);

    const [entry] = await itineraryRows(created.id);
    expect(entry.sentence).toMatch(/„Westort" neu geplant \(kürzer oder entfernt\)/);
    expect(entry.undoable).toBe(true);

    const journal = await undoPlanOp({ planId: created.id, opId: entry.id });
    const undone = journal.entries.find((e) => e.id === entry.id)!;
    expect(undone.undoable).toBe(false);
    expect(undone.undoneAt).not.toBeNull();
    expect(journal.entries.some((e) => e.kind === "itinerary-undo")).toBe(true);

    const { plan } = await getTripPlan({ planId: created.id });
    expect(plan.legs[0].id).toBe(leg.id);
    expect(plan.legs[0].days).toHaveLength(2);
    expect(stopRefs(plan.legs[0])).toEqual(refsBefore);
    // Back on the day, not also waiting in the pool.
    expect(plan.legs[0].pool.map((c) => c.osmRef).filter((r) => refsBefore.includes(r))).toEqual([]);

    await expect(undoPlanOp({ planId: created.id, opId: entry.id })).rejects.toThrow(/schon zurückgenommen/);
  });

  it("brings a removed stay back with its days", async () => {
    const created = await twoStays();
    const east = created.legs.find((l) => l.title === "Ostort")!;
    const refsBefore = stopRefs(east);
    expect(refsBefore.length).toBeGreaterThan(0);

    const chain = await chainOf(created.id);
    const { plan: without } = await write(created.id, { ...chain, items: chain.items.slice(0, stayAt(chain.items, 0) + 1) });
    expect(without.legs.filter((l) => l.kind === "stay")).toHaveLength(1);

    const [entry] = await itineraryRows(created.id);
    await undoPlanOp({ planId: created.id, opId: entry.id });

    const { plan } = await getTripPlan({ planId: created.id });
    const stays = plan.legs.filter((l) => l.kind === "stay");
    expect(stays.map((l) => l.title)).toEqual(["Westort", "Ostort"]);
    expect(stopRefs(stays[1])).toEqual(refsBefore);
  });

  it("only offers the newest change, and journals nothing when no planned day was touched", async () => {
    const created = await oneStay();
    await editStay(created.id, 0, { days: 3 });
    await editStay(created.id, 0, { days: 1 });
    const rows = await itineraryRows(created.id);
    expect(rows).toHaveLength(2);
    const [newest, older] = rows;
    expect(newest.undoable).toBe(true);
    expect(older.undoable).toBe(false);
    await expect(undoPlanOp({ planId: created.id, opId: older.id })).rejects.toThrow(/letzte Änderung/);

    // Once the newest is back, the one before it is the newest.
    await undoPlanOp({ planId: created.id, opId: newest.id });
    expect((await itineraryRows(created.id)).find((e) => e.id === older.id)!.undoable).toBe(true);
    await undoPlanOp({ planId: created.id, opId: older.id });
    const { plan } = await getTripPlan({ planId: created.id });
    expect(plan.legs[0].days).toHaveLength(2);

    const plain = await oneStay();
    await editStay(plain.id, 0, { anchorLabel: "Pension Musterhof" });
    expect(await itineraryRows(plain.id)).toEqual([]);
  });
});
