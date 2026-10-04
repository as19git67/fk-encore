/**
 * A journey between two legs (§22.7): the leg it leaves ends with the
 * departure, the leg it reaches begins with the arrival, and the
 * journey in between is planned along the corridor.
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
import { createTripPlan, detailTripDay, getTripPlan } from "./plans";
import { removeTripFixpoint } from "./fixpoint-edit";
import { removeTripLeg, updateTripLeg } from "./legs";
import { addTripTransit, updateTripTransit } from "./transits";
import { getUserHome, setTripHome, setUserHomeEndpoint } from "./home";
import { applyVotesToPlan, castVote } from "./plan-votes";

const ANCHOR = { lat: 48.37, lon: 10.9 };
const NEXT = { lat: 48.37, lon: 11.4 };
const LATER = { lat: 48.37, lon: 11.45 };
// Inside the seeded region too, a good way west of the first place.
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

let geo: InMemoryGeoClient;
let ownerId = 0;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `transit-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
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
    // Around the first base, around the second, and one on the way.
    spot(1, ANCHOR.lat + 0.003, ANCHOR.lon), spot(2, ANCHOR.lat - 0.003, ANCHOR.lon),
    spot(3, ANCHOR.lat, ANCHOR.lon + 0.25),
    spot(4, NEXT.lat + 0.003, NEXT.lon), spot(5, NEXT.lat - 0.003, NEXT.lon),
  ]);
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function threeLegs() {
  const { plan } = await createTripPlan({
    legs: [
      { title: "Erster Ort", anchor: ANCHOR, anchorLabel: "Hotel am Fluss", days: 2, startDate: "2026-09-05", mode: "car" },
      { title: "Zweiter Ort", anchor: NEXT, anchorLabel: "Pension am See", days: 2, startDate: "2026-09-07", mode: "car" },
      { title: "Dritter Ort", anchor: LATER, days: 1, startDate: "2026-09-10", mode: "car" },
    ],
  });
  return plan;
}

describe("POST /trip-planner/plans/:planId/transits", () => {
  it("puts the journey between two legs and frames both neighbours by it", async () => {
    const plan = await threeLegs();

    const { plan: after } = await addTripTransit({
      planId: plan.id, afterLegIndex: 0,
      departDate: "2026-09-06", departAt: "10:00",
      arriveDate: "2026-09-06", arriveAt: "16:00",
    });

    expect(after.legs.map((l) => [l.position, l.kind, l.title])).toEqual([
      [0, "stay", "Erster Ort"],
      [1, "transit", "Weiterreise nach Zweiter Ort"],
      [2, "stay", "Zweiter Ort"],
      [3, "stay", "Dritter Ort"],
    ]);
    const [left, journey, reached, later] = after.legs;

    // The leg being left ends on the day of departure, with it.
    expect(left.days).toHaveLength(2);
    const departure = left.days[1].fixpoints.find((f) => f.kind === "departure");
    expect(departure).toMatchObject({ startMinutes: 600, label: "Weiterreise nach Zweiter Ort" });

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

    // The leg reached begins on the day of arrival, at the arrival —
    // a day earlier than before — and every leg after it moves along.
    expect(reached.startDate).toBe("2026-09-06");
    expect(reached.arriveMinutes).toBe(960);
    expect(later.startDate).toBe("2026-09-09");
  });

  it("frames a journey by train without planning into it", async () => {
    const plan = await threeLegs();
    const { plan: after } = await addTripTransit({
      planId: plan.id, afterLegIndex: 0, mode: "transit",
      departDate: "2026-09-06", departAt: "10:00", arriveDate: "2026-09-06", arriveAt: "16:00",
    });
    const day = after.legs[1].days[0];
    expect(day.detailed).toBe(false);
    expect(day.bufferReason).toBe("Unterwegs mit Bahn oder Bus");
    expect(day.blocks.flatMap((b) => b.stops)).toEqual([]);
  });

  it("refuses what cannot be a journey", async () => {
    const plan = await threeLegs();
    const base = { planId: plan.id, afterLegIndex: 0, departDate: "2026-09-06", arriveDate: "2026-09-06" };
    await expect(addTripTransit({ ...base, departAt: "16:00", arriveAt: "10:00" }))
      .rejects.toMatchObject({ code: "invalid_argument" });
    await expect(addTripTransit({ ...base, afterLegIndex: 2, departAt: "10:00", arriveAt: "16:00" }))
      .rejects.toMatchObject({ code: "failed_precondition" });

    await addTripTransit({ ...base, departAt: "10:00", arriveAt: "16:00" });
    await expect(addTripTransit({ ...base, departAt: "10:00", arriveAt: "16:00" }))
      .rejects.toMatchObject({ code: "failed_precondition" });
  });

  it("dates an undated trip from the journey", async () => {
    const { plan } = await createTripPlan({
      legs: [
        { title: "Erster Ort", anchor: ANCHOR, days: 2, mode: "car" },
        { title: "Zweiter Ort", anchor: NEXT, days: 3, mode: "car" },
      ],
    });
    expect(plan.legs.map((l) => l.startDate)).toEqual([null, null]);

    // Between the two places: the first ends on the day of departure,
    // so the trip's first day is counted back from it.
    const { plan: after } = await addTripTransit({
      planId: plan.id, afterLegIndex: 0,
      departDate: "2026-09-06", departAt: "10:00", arriveDate: "2026-09-06", arriveAt: "16:00",
    });
    expect(after.legs.map((l) => [l.kind, l.startDate])).toEqual([
      ["stay", "2026-09-05"],
      ["transit", "2026-09-06"],
      ["stay", "2026-09-06"],
    ]);
  });

  it("dates an undated trip from the journey home", async () => {
    const { plan } = await createTripPlan({
      legs: [
        { title: "Erster Ort", anchor: ANCHOR, days: 2, mode: "car" },
        { title: "Zweiter Ort", anchor: NEXT, days: 3, mode: "car" },
      ],
    });
    await setTripHome({ planId: plan.id, ...HOME, label: "Zuhause" });

    // Leaving the last place on the 10th after three days there and
    // two before: the trip began on the 6th.
    const { plan: after } = await addTripTransit({
      planId: plan.id, afterLegIndex: 1,
      departDate: "2026-09-10", departAt: "10:00", arriveDate: "2026-09-10", arriveAt: "15:00",
    });
    expect(after.legs.map((l) => [l.kind, l.startDate])).toEqual([
      ["stay", "2026-09-06"],
      ["stay", "2026-09-08"],
      ["transit", "2026-09-10"],
    ]);
  });
});

describe("renumbering legs", () => {
  it("survives inserting in front of, and removing from in front of, several legs", async () => {
    const plan = await threeLegs();
    const { plan: withJourney } = await addTripTransit({
      planId: plan.id, afterLegIndex: 0,
      departDate: "2026-09-06", departAt: "10:00", arriveDate: "2026-09-06", arriveAt: "16:00",
    });
    expect(withJourney.legs.map((l) => l.position)).toEqual([0, 1, 2, 3]);

    const { plan: without } = await removeTripLeg({ planId: plan.id, legIndex: 1 });
    expect(without.legs.map((l) => [l.position, l.title]))
      .toEqual([[0, "Erster Ort"], [1, "Zweiter Ort"], [2, "Dritter Ort"]]);
  });
});

describe("PATCH /trip-planner/plans/:planId/transits/:legIndex", () => {
  async function withJourney() {
    const plan = await threeLegs();
    const { plan: after } = await addTripTransit({
      planId: plan.id, afterLegIndex: 0,
      departDate: "2026-09-06", departAt: "10:00", arriveDate: "2026-09-06", arriveAt: "16:00",
    });
    return after;
  }

  it("changes the journey in place and moves the neighbours with it", async () => {
    const before = await withJourney();
    const journey = before.legs[1];

    // Leaving an hour later and arriving the next morning.
    const { plan: after } = await updateTripTransit({
      planId: before.id, legIndex: 1,
      departDate: "2026-09-06", departAt: "11:00", arriveDate: "2026-09-07", arriveAt: "09:00",
    });

    // The same journey — its row, its place, its name — with new moments.
    const changed = after.legs[1];
    expect(changed).toMatchObject({
      id: journey.id, kind: "transit", title: journey.title,
      startDate: "2026-09-06", departMinutes: 660, endMinutes: 540,
    });
    expect(changed.days).toHaveLength(2);
    // Over night: a frame without stops.
    expect(changed.days.every((d) => !d.detailed)).toBe(true);

    // The leg left now departs at eleven.
    expect(after.legs[0].days.at(-1)!.fixpoints.find((f) => f.kind === "departure")?.startMinutes)
      .toBe(660);
    // The leg reached begins the next day at nine; the one after moves too.
    expect(after.legs[2]).toMatchObject({ startDate: "2026-09-07", arriveMinutes: 540 });
    expect(after.legs[3].startDate).toBe("2026-09-10");
  });

  it("changes how the journey travels", async () => {
    const before = await withJourney();
    const { plan: after } = await updateTripTransit({
      planId: before.id, legIndex: 1, mode: "transit",
      departDate: "2026-09-06", departAt: "10:00", arriveDate: "2026-09-06", arriveAt: "16:00",
    });
    expect(after.legs[1].mode).toBe("transit");
    expect(after.legs[1].days[0].bufferReason).toBe("Unterwegs mit Bahn oder Bus");
  });

  it("refuses what is not a journey, and leaves the journey as it was when refusing", async () => {
    const before = await withJourney();
    await expect(updateTripTransit({
      planId: before.id, legIndex: 0,
      departDate: "2026-09-06", departAt: "10:00", arriveDate: "2026-09-06", arriveAt: "16:00",
    })).rejects.toMatchObject({ code: "failed_precondition" });
    await expect(updateTripTransit({
      planId: before.id, legIndex: 1,
      departDate: "2026-09-06", departAt: "16:00", arriveDate: "2026-09-06", arriveAt: "10:00",
    })).rejects.toMatchObject({ code: "invalid_argument" });

    const { plan: still } = await getTripPlan({ planId: before.id });
    expect(still.legs[1]).toMatchObject({ kind: "transit", departMinutes: 600, endMinutes: 960 });
  });

  it("keeps the journey's own departure and arrival where they are", async () => {
    const plan = await withJourney();
    const journey = plan.legs[1];
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
    const before = await withJourney();
    // Over night: two days, neither of them plannable.
    const { plan } = await updateTripTransit({
      planId: before.id, legIndex: 1,
      departDate: "2026-09-06", departAt: "18:00", arriveDate: "2026-09-07", arriveAt: "08:00",
    });
    expect(plan.legs[1].days.every((d) => !d.detailed)).toBe(true);
    await expect(detailTripDay({ planId: plan.id, legIndex: 1, dayIndex: 1 }))
      .rejects.toMatchObject({ code: "failed_precondition" });
  });
});

describe("the way there and the way home", () => {
  it("needs a home, and forgets it again", async () => {
    const plan = await threeLegs();
    await expect(addTripTransit({
      planId: plan.id, afterLegIndex: -1,
      departDate: "2026-09-05", departAt: "08:00", arriveDate: "2026-09-05", arriveAt: "12:00",
    })).rejects.toMatchObject({ code: "failed_precondition" });

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
    const plan = await threeLegs();
    await setTripHome({ planId: plan.id, ...HOME, label: "Zuhause" });

    const { plan: after } = await addTripTransit({
      planId: plan.id, afterLegIndex: -1,
      departDate: "2026-09-05", departAt: "08:00", arriveDate: "2026-09-05", arriveAt: "12:00",
    });

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

    // Only once.
    await expect(addTripTransit({
      planId: plan.id, afterLegIndex: -1,
      departDate: "2026-09-05", departAt: "08:00", arriveDate: "2026-09-05", arriveAt: "12:00",
    })).rejects.toMatchObject({ code: "failed_precondition" });
  });

  it("appends the journey home, ending the last place with the departure", async () => {
    const plan = await threeLegs();
    await setTripHome({ planId: plan.id, ...HOME, label: "Zuhause" });

    const { plan: after } = await addTripTransit({
      planId: plan.id, afterLegIndex: 2,
      departDate: "2026-09-10", departAt: "10:00", arriveDate: "2026-09-10", arriveAt: "15:00",
    });

    const journey = after.legs[3];
    expect(journey).toMatchObject({
      kind: "transit", title: "Heimreise von Dritter Ort", anchor: HOME, anchorLabel: "Zuhause",
      origin: { lat: LATER.lat, lon: LATER.lon }, startDate: "2026-09-10",
    });
    const last = after.legs[2];
    expect(last.days.at(-1)!.fixpoints.find((f) => f.kind === "departure"))
      .toMatchObject({ startMinutes: 600, label: "Weiterreise nach Zuhause" });

    // And it can be changed in place like any journey.
    const { plan: changed } = await updateTripTransit({
      planId: plan.id, legIndex: 3,
      departDate: "2026-09-10", departAt: "14:00", arriveDate: "2026-09-10", arriveAt: "19:00",
    });
    expect(changed.legs[3]).toMatchObject({ id: journey.id, departMinutes: 840, endMinutes: 1140 });
  });
});

describe("voting on the way", () => {
  it("lets the group turn a stop on the journey down, and the next plan leaves it out", async () => {
    const plan = await threeLegs();
    const { plan: after } = await addTripTransit({
      planId: plan.id, afterLegIndex: 0,
      departDate: "2026-09-06", departAt: "10:00", arriveDate: "2026-09-06", arriveAt: "16:00",
    });
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

  it("ends a port day with 'Alle an Bord' and an hour in hand, and calls the sea a day aboard", async () => {
    const plan = await twoPorts();
    const { plan: after } = await addTripTransit({
      planId: plan.id, afterLegIndex: 0, mode: "ship",
      departDate: "2026-09-05", departAt: "17:00", arriveDate: "2026-09-07", arriveAt: "08:00",
    });
    const [port, sea, nextPort] = after.legs;
    expect(sea.title).toBe("An Bord nach Zweiter Hafen");
    expect(sea.mode).toBe("ship");
    expect(sea.days).toHaveLength(3);
    expect(sea.days.map((d) => d.bufferReason)).toEqual(["An Bord", "An Bord", "An Bord"]);
    expect(sea.days.flatMap((d) => d.blocks.flatMap((b) => b.stops))).toEqual([]);

    const departure = port.days[0].fixpoints.find((f) => f.kind === "departure");
    expect(departure).toMatchObject({ label: "Alle an Bord", startMinutes: 1020, bufferMinutes: 60 });
    expect(nextPort.startDate).toBe("2026-09-07");
    expect(nextPort.arriveMinutes).toBe(480);
  });

  it("gives a tender port the boat ride back on top", async () => {
    const plan = await twoPorts();
    await setTripHome({ planId: plan.id, lat: HOME.lat, lon: HOME.lon, label: "Zuhause" });
    const { plan: after } = await addTripTransit({
      planId: plan.id, afterLegIndex: 1, mode: "ship",
      departDate: "2026-09-07", departAt: "18:00", arriveDate: "2026-09-08", arriveAt: "09:00",
    });
    const tenderPort = after.legs[1];
    const departure = tenderPort.days[0].fixpoints.find((f) => f.kind === "departure");
    expect(departure).toMatchObject({ label: "Alle an Bord", bufferMinutes: 90 });
  });

  it("rewrites the departure when the property changes after the journey was made", async () => {
    const plan = await threeLegs();
    await addTripTransit({
      planId: plan.id, afterLegIndex: 0, mode: "ship",
      departDate: "2026-09-06", departAt: "17:00", arriveDate: "2026-09-07", arriveAt: "08:00",
    });
    // A hotel until somebody says otherwise: the train's margin.
    let { plan: current } = await getTripPlan({ planId: plan.id });
    expect(current.legs[0].days[1].fixpoints.find((f) => f.kind === "departure"))
      .toMatchObject({ label: "Weiterreise nach Zweiter Ort", bufferMinutes: 20 });

    ({ plan: current } = await updateTripLeg({ planId: plan.id, legIndex: 0, quartersAboard: true }));
    expect(current.legs[0].quartersAboard).toBe(true);
    expect(current.legs[0].days[1].fixpoints.find((f) => f.kind === "departure"))
      .toMatchObject({ label: "Alle an Bord", bufferMinutes: 60, startMinutes: 1020 });

    ({ plan: current } = await updateTripLeg({ planId: plan.id, legIndex: 0, tenderPort: true }));
    expect(current.legs[0].days[1].fixpoints.find((f) => f.kind === "departure"))
      .toMatchObject({ label: "Alle an Bord", bufferMinutes: 90 });

    ({ plan: current } = await updateTripLeg({ planId: plan.id, legIndex: 0, quartersAboard: false }));
    expect(current.legs[0].days[1].fixpoints.find((f) => f.kind === "departure"))
      .toMatchObject({ label: "Weiterreise nach Zweiter Ort", bufferMinutes: 20 });
  });

  it("only keeps the property while no journey leaves the leg", async () => {
    const plan = await threeLegs();
    const { plan: after } = await updateTripLeg({ planId: plan.id, legIndex: 2, quartersAboard: true, tenderPort: true });
    expect(after.legs[2]).toMatchObject({ quartersAboard: true, tenderPort: true });
    expect(after.legs[2].days[0].fixpoints.filter((f) => f.kind === "departure")).toEqual([]);
  });
});
