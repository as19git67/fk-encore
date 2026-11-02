/**
 * The trip as one chain (documentation/plans/reiseverlauf.md, stage 1):
 * a stay owns its days, a journey its times, the trip its one date,
 * and every other date follows.
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
import { createTripPlan, setTripStopStatus } from "./plans";
import { setTripHome } from "./home";
import {
  deriveFrames,
  getTripItinerary,
  putTripItinerary,
  type ItineraryItem,
} from "./itinerary";

const ANCHOR = { lat: 48.37, lon: 10.9 };
const NEXT = { lat: 48.37, lon: 11.4 };
const LATER = { lat: 48.37, lon: 11.45 };
const HOME = { lat: 48.5, lon: 10.55 };
const DB = "nom_west";

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

// MARK: - The derivation, pure

describe("deriveFrames", () => {
  const stay = (title: string, days: number, extra: Partial<ItineraryItem> = {}): ItineraryItem =>
    ({ kind: "stay", title, anchor: ANCHOR, days, ...extra });
  const journey = (extra: Partial<ItineraryItem> = {}): ItineraryItem => ({ kind: "journey", ...extra });

  it("dates the chain from the one date: a stay runs over its days, a journey leaves on the last", () => {
    const frames = deriveFrames({
      startDate: "2027-06-03",
      items: [
        journey({ departAt: "08:00", arriveAt: "14:00" }),
        stay("Erster Ort", 4),
        journey({ departAt: "10:00", arriveAt: "15:00" }),
        stay("Zweiter Ort", 3),
        journey({ departAt: "09:00", arriveAt: "18:00" }),
      ],
    }, { home: true, homeLabel: "Zuhause" });

    expect(frames.map((f) => [f.kind, f.startDate, f.endDate])).toEqual([
      ["journey", "2027-06-03", "2027-06-03"],
      ["stay", "2027-06-03", "2027-06-06"],
      ["journey", "2027-06-06", "2027-06-06"],
      ["stay", "2027-06-06", "2027-06-08"],
      ["journey", "2027-06-08", "2027-06-08"],
    ]);
    // The stay gets its arrival from the journey before and its
    // departure from the journey after, named after where it goes.
    expect(frames[1]).toMatchObject({
      arriveMinutes: 14 * 60,
      departure: { at: "10:00", nextTitle: "Zweiter Ort" },
    });
    expect(frames[3]).toMatchObject({
      arriveMinutes: 15 * 60,
      departure: { at: "09:00", nextTitle: "Zuhause" },
    });
    expect(frames[0]).toMatchObject({ timed: true, days: 1, from: null, to: 1 });
    expect(frames[4]).toMatchObject({ timed: true, from: 3, to: null });
  });

  it("gives a night on the way its own day, and a journey without times no leg", () => {
    const frames = deriveFrames({
      startDate: "2027-06-03",
      items: [
        stay("Erster Ort", 2),
        journey({ departAt: "22:00", arriveAt: "07:00", nights: 1 }),
        stay("Zweiter Ort", 2),
        journey({ nights: 0 }),
        stay("Dritter Ort", 1),
      ],
    }, { home: false, homeLabel: "Zuhause" });

    expect(frames.map((f) => [f.startDate, f.endDate])).toEqual([
      ["2027-06-03", "2027-06-04"],
      ["2027-06-04", "2027-06-05"],
      ["2027-06-05", "2027-06-06"],
      ["2027-06-06", "2027-06-06"],
      ["2027-06-06", "2027-06-06"],
    ]);
    expect(frames[1]).toMatchObject({ timed: true, days: 2 });
    expect(frames[3]).toMatchObject({ timed: false, days: 1 });
    // Nobody knows when the third place is reached, so its first day
    // is a whole one; the second place still ends with its departure.
    expect(frames[4]).toMatchObject({ arriveMinutes: null, departure: null });
    expect(frames[2]).toMatchObject({ arriveMinutes: 7 * 60, departure: null });
  });

  it("works without a date, and reads the first stay's own arrival when no journey leads in", () => {
    const frames = deriveFrames({
      startDate: null,
      items: [stay("Erster Ort", 3, { arriveAt: "14:00" }), journey(), stay("Zweiter Ort", 2)],
    }, { home: false, homeLabel: "Zuhause" });
    expect(frames.every((f) => f.startDate === null && f.endDate === null)).toBe(true);
    expect(frames[0]).toMatchObject({ arriveMinutes: 14 * 60 });
  });

  it("refuses what is not a chain", () => {
    const options = { home: false, homeLabel: "Zuhause" };
    expect(() => deriveFrames({ startDate: null, items: [stay("A", 1), stay("B", 1)] }, options))
      .toThrow(/Weiterreise/);
    expect(() => deriveFrames({ startDate: null, items: [journey(), stay("A", 1)] }, options))
      .toThrow(/Zuhause/);
    expect(() => deriveFrames({ startDate: null, items: [stay("A", 0)] }, options))
      .toThrow(/days/);
    expect(() => deriveFrames({ startDate: null, items: [journey()] }, { ...options, home: true }))
      .toThrow(/Aufenthalt/);
    expect(() => deriveFrames({
      startDate: null,
      items: [stay("A", 1), journey({ departAt: "16:00", arriveAt: "10:00" }), stay("B", 1)],
    }, options)).toThrow(/Ankunft/);
    expect(() => deriveFrames({
      startDate: null,
      items: [stay("A", 1), journey({ departAt: "16:00", arriveAt: "10:00", nights: 1 }), stay("B", 1)],
    }, options)).not.toThrow();
    expect(() => deriveFrames({ startDate: "2027-02-30", items: [stay("A", 1)] }, options))
      .toThrow(/startDate/);
  });
});

// MARK: - Against the database

let geo: InMemoryGeoClient;
let ownerId = 0;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `itinerary-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = user.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(ownerId),
    permissions: ["photos.view"],
  });
  await db.insert(osmRegionImports).values({
    slug: "europe/west",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: DB,
    bbox_min_lat: 48.2,
    bbox_min_lon: 10.5,
    bbox_max_lat: 48.6,
    bbox_max_lon: 11.6,
    status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  geo.setSearchSpots(DB, [
    spot(1, ANCHOR.lat + 0.003, ANCHOR.lon), spot(2, ANCHOR.lat - 0.003, ANCHOR.lon),
    spot(3, ANCHOR.lat, ANCHOR.lon + 0.25),
    spot(4, NEXT.lat + 0.003, NEXT.lon), spot(5, NEXT.lat - 0.003, NEXT.lon),
    spot(6, LATER.lat + 0.003, LATER.lon),
  ]);
  setGeoClient(geo);
  return () => resetGeoClient();
});

/**
 * Give the journey after the stay at `afterStay` both of its times —
 * the gesture the app makes on a journey card — and write the chain.
 */
async function addJourney(
  planId: number,
  afterStay: number,
  journey: { departAt: string; arriveAt: string; nights?: number },
) {
  const chain = await getTripItinerary({ planId });
  const items = chain.items.map((i) => ({ ...i }));
  const stayIndex = items.flatMap((item, index) => (item.kind === "stay" ? [index] : []))[afterStay];
  // The gap the chain read back is replaced, not kept: a journey by day
  // unless the caller says otherwise.
  Object.assign(items[stayIndex + 1], { nights: 0, ...journey });
  return putTripItinerary({ planId, startDate: chain.startDate, items });
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

describe("GET /trip-planner/plans/:planId/itinerary", () => {
  it("reads a trip written before the chain existed back with the dates it has", async () => {
    const plan = await threeStays();
    const chain = await getTripItinerary({ planId: plan.id });

    expect(chain.startDate).toBe("2026-09-05");
    expect(chain.items.map((i) => [i.kind, i.title ?? null, i.startDate, i.endDate])).toEqual([
      ["stay", "Erster Ort", "2026-09-05", "2026-09-06"],
      // The gap between two stays is what the implicit journey knows.
      ["journey", null, "2026-09-06", "2026-09-07"],
      ["stay", "Zweiter Ort", "2026-09-07", "2026-09-08"],
      ["journey", null, "2026-09-08", "2026-09-10"],
      ["stay", "Dritter Ort", "2026-09-10", "2026-09-10"],
    ]);
    expect(chain.items[1]).toMatchObject({ nights: 1, departAt: null, arriveAt: null });
    expect(chain.items[3]).toMatchObject({ nights: 2 });
    expect(chain.items[0]).toMatchObject({ legId: plan.legs[0].id, days: 2, anchorLabel: "Hotel am Fluss", mode: "car" });
  });

  it("reads a journey as the item that owns its times", async () => {
    const plan = await threeStays();
    await addJourney(plan.id, 0, { departAt: "10:00", arriveAt: "16:00" });
    const chain = await getTripItinerary({ planId: plan.id });
    expect(chain.items[1]).toMatchObject({
      kind: "journey", departAt: "10:00", arriveAt: "16:00", nights: 0, mode: "car",
      title: "Weiterreise nach Zweiter Ort", startDate: "2026-09-06", endDate: "2026-09-06",
    });
    expect(chain.items[1].legId).toBeDefined();
    // The stay does not carry an arrival of its own once a journey leads into it.
    expect(chain.items[2].arriveAt).toBeUndefined();
  });
});

describe("PUT /trip-planner/plans/:planId/itinerary", () => {
  it("moves every later stay when one gets longer, and keeps the legs' ids", async () => {
    const plan = await threeStays();
    const chain = await getTripItinerary({ planId: plan.id });
    const items = chain.items.map((i) => ({ ...i }));
    items[0].days = 3;

    const { plan: after } = await putTripItinerary({ planId: plan.id, startDate: chain.startDate, items });

    expect(after.legs.map((l) => [l.position, l.id, l.startDate, l.days.length])).toEqual([
      [0, plan.legs[0].id, "2026-09-05", 3],
      [1, plan.legs[1].id, "2026-09-08", 2],
      [2, plan.legs[2].id, "2026-09-11", 1],
    ]);
  });

  it("inserts a stay in the middle with the journey into it, and frames both neighbours", async () => {
    const plan = await threeStays();
    const chain = await getTripItinerary({ planId: plan.id });
    const [first, gap1, second, gap2, third] = chain.items;
    const items: ItineraryItem[] = [
      first,
      { kind: "journey", departAt: "09:30", arriveAt: "12:00" },
      { kind: "stay", title: "Neuer Ort", anchor: { lat: 48.37, lon: 11.2 }, days: 2, mode: "car" },
      { ...gap1, departAt: "10:00", arriveAt: "16:00", nights: 0 },
      second,
      gap2,
      third,
    ];

    const { plan: after } = await putTripItinerary({ planId: plan.id, startDate: chain.startDate, items });

    expect(after.legs.map((l) => [l.position, l.kind, l.title, l.startDate])).toEqual([
      [0, "stay", "Erster Ort", "2026-09-05"],
      [1, "transit", "Weiterreise nach Neuer Ort", "2026-09-06"],
      [2, "stay", "Neuer Ort", "2026-09-06"],
      [3, "transit", "Weiterreise nach Zweiter Ort", "2026-09-07"],
      [4, "stay", "Zweiter Ort", "2026-09-07"],
      [5, "stay", "Dritter Ort", "2026-09-10"],
    ]);
    const [left, journey, inserted, , reached] = after.legs;
    // The stay being left ends with the departure; the one reached starts at the arrival.
    expect(left.days[1].fixpoints.find((f) => f.kind === "departure"))
      .toMatchObject({ startMinutes: 570, label: "Weiterreise nach Neuer Ort" });
    expect(inserted.arriveMinutes).toBe(12 * 60);
    expect(inserted.days[1].fixpoints.find((f) => f.kind === "departure"))
      .toMatchObject({ startMinutes: 600, label: "Weiterreise nach Zweiter Ort" });
    expect(reached.arriveMinutes).toBe(16 * 60);
    expect(journey).toMatchObject({
      departMinutes: 570, endMinutes: 720, mode: "car",
      origin: { lat: ANCHOR.lat, lon: ANCHOR.lon, label: "Hotel am Fluss" },
    });
    // The old stays keep their rows.
    expect(reached.id).toBe(plan.legs[1].id);
  });

  it("reorders stays by moving their rows, and dates them anew", async () => {
    const plan = await threeStays();
    const chain = await getTripItinerary({ planId: plan.id });
    const [first, gap1, second, gap2, third] = chain.items;

    const { plan: after } = await putTripItinerary({
      planId: plan.id, startDate: "2026-10-01", items: [second, gap1, first, gap2, third],
    });

    expect(after.legs.map((l) => [l.position, l.id, l.title, l.startDate])).toEqual([
      [0, plan.legs[1].id, "Zweiter Ort", "2026-10-01"],
      [1, plan.legs[0].id, "Erster Ort", "2026-10-03"],
      [2, plan.legs[2].id, "Dritter Ort", "2026-10-06"],
    ]);
    // Moved, not re-planned: the days are the ones the solver made.
    expect(after.legs[1].days.map((d) => d.blocks.flatMap((b) => b.stops.map((s) => s.osmRef))))
      .toEqual(plan.legs[0].days.map((d) => d.blocks.flatMap((b) => b.stops.map((s) => s.osmRef))));
  });

  it("removes a stay that is missing from the chain, and a journey whose times are gone", async () => {
    const plan = await threeStays();
    await addJourney(plan.id, 0, { departAt: "10:00", arriveAt: "16:00" });
    const chain = await getTripItinerary({ planId: plan.id });
    const [first, journey, , gap2, third] = chain.items;

    // The second stay goes; the journey after the first is still there
    // but loses its arrival, so it is no longer a leg.
    const { plan: after } = await putTripItinerary({
      planId: plan.id, startDate: chain.startDate,
      items: [first, { ...journey, arriveAt: null, nights: gap2.nights }, third],
    });

    expect(after.legs.map((l) => [l.position, l.kind, l.title, l.startDate])).toEqual([
      [0, "stay", "Erster Ort", "2026-09-05"],
      [1, "stay", "Dritter Ort", "2026-09-08"],
    ]);
    // A departure that is still known stays on the last day.
    expect(after.legs[0].days[1].fixpoints.find((f) => f.kind === "departure"))
      .toMatchObject({ startMinutes: 600, label: "Weiterreise nach Dritter Ort" });
  });

  it("takes the dates off and puts them back", async () => {
    const plan = await threeStays();
    const chain = await getTripItinerary({ planId: plan.id });

    const { plan: undated } = await putTripItinerary({ planId: plan.id, startDate: null, items: chain.items });
    expect(undated.legs.map((l) => l.startDate)).toEqual([null, null, null]);

    const again = await getTripItinerary({ planId: plan.id });
    const { plan: dated } = await putTripItinerary({ planId: plan.id, startDate: "2026-09-05", items: again.items });
    // Without dates the gaps were forgotten; the chain closes them.
    expect(dated.legs.map((l) => l.startDate)).toEqual(["2026-09-05", "2026-09-06", "2026-09-07"]);
  });

  it("frames the way there and the way home once the trip knows where home is", async () => {
    const plan = await threeStays();
    await setTripHome({ planId: plan.id, ...HOME, label: "Zuhause" });
    const chain = await getTripItinerary({ planId: plan.id });

    const { plan: after } = await putTripItinerary({
      planId: plan.id, startDate: chain.startDate,
      items: [
        { kind: "journey", departAt: "08:00", arriveAt: "13:00" },
        ...chain.items,
        { kind: "journey", departAt: "11:00", arriveAt: "17:00" },
      ],
    });
    expect(after.legs.map((l) => [l.kind, l.title])).toEqual([
      ["transit", "Anreise nach Erster Ort"],
      ["stay", "Erster Ort"],
      ["stay", "Zweiter Ort"],
      ["stay", "Dritter Ort"],
      ["transit", "Heimreise von Dritter Ort"],
    ]);
    expect(after.legs[1].arriveMinutes).toBe(13 * 60);
    expect(after.legs[3].days[0].fixpoints.find((f) => f.kind === "departure"))
      .toMatchObject({ startMinutes: 660, label: "Weiterreise nach Zuhause" });
  });

  it("refuses to re-plan or remove a stay somebody has begun, and writes nothing", async () => {
    const plan = await threeStays();
    const stop = plan.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    await setTripStopStatus({ planId: plan.id, stopId: stop.rowId, status: "done" });
    const chain = await getTripItinerary({ planId: plan.id });

    const longer = chain.items.map((i) => ({ ...i }));
    longer[0].days = 3;
    await expect(putTripItinerary({ planId: plan.id, startDate: chain.startDate, items: longer }))
      .rejects.toMatchObject({ code: "failed_precondition" });
    await expect(putTripItinerary({ planId: plan.id, startDate: chain.startDate, items: chain.items.slice(2) }))
      .rejects.toMatchObject({ code: "failed_precondition" });

    // A new date is not a re-plan, so it still goes through.
    const { plan: moved } = await putTripItinerary({ planId: plan.id, startDate: "2026-09-12", items: chain.items });
    expect(moved.legs.map((l) => l.startDate)).toEqual(["2026-09-12", "2026-09-14", "2026-09-17"]);
  });

  it("refuses a leg id that is not this trip's", async () => {
    const plan = await threeStays();
    const chain = await getTripItinerary({ planId: plan.id });
    const items = chain.items.map((i) => ({ ...i }));
    items[0].legId = 999_999;
    await expect(putTripItinerary({ planId: plan.id, startDate: chain.startDate, items }))
      .rejects.toMatchObject({ code: "invalid_argument" });
  });
});
