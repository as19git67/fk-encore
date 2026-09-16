/**
 * A base and day trips out of it (§4.5), at the endpoint.
 *
 * The case the concept names by example: three days in one Airbnb, and
 * two of them forty to sixty kilometres away. One leg — the quarters
 * never move, there is no transfer day, the luggage stays put — and
 * until now it could not be said at all: the anchor belonged to the leg
 * and Florence was not in the pool.
 *
 * Places invented, distances Tuscan.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, detailTripDay } from "./plans";
import { setTripDayAnchor } from "./day-anchor-edit";
import { hideTripSpot } from "./hidden-spots";

/** The base, and a town an hour away by car. */
const BASE = { lat: 43.4677, lon: 11.0430 };
const TOWN = { lat: 43.7731, lon: 11.2560 };
/** Twenty kilometres out of that town: a car's reach, nobody's city. */
const OUT_OF_TOWN = { lat: 43.7731, lon: 11.5040 };
const DB = "nom_centro";

function spot(n: number, at: { lat: number; lon: number }): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: at.lat + (n % 5) * 0.002,
    lon: at.lon + Math.floor(n / 5) * 0.002,
    distanceM: null,
    detourM: null,
    name: `Sehenswürdigkeit ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: `Q${n}`,
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
    .values({ email: `dayanchor-${Date.now()}@test.invalid`, name: "P", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(user.id),
    permissions: ["photos.view"],
  });
  await db.insert(osmRegionImports).values({
    slug: "italy/centro",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: DB,
    bbox_min_lat: 42.0,
    bbox_min_lon: 9.5,
    bbox_max_lat: 44.5,
    bbox_max_lon: 12.5,
    status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  geo.setSearchSpots(DB, [
    ...Array.from({ length: 8 }, (_, i) => spot(i + 1, BASE)),
    ...Array.from({ length: 8 }, (_, i) => spot(i + 21, TOWN)),
  ]);
  setGeoClient(geo);
  return () => resetGeoClient();
});

function stopsOf(plan: Awaited<ReturnType<typeof createTripPlan>>["plan"], dayIndex: number) {
  const day = plan.legs[0].days.find((d) => d.dayIndex === dayIndex);
  return (day?.blocks ?? []).flatMap((b) => b.stops.map((s) => s.osmRef));
}

describe("a base with day trips (§4.5)", () => {
  it("plans the day out of the destination's pool, not the base's", async () => {
    const { plan } = await createTripPlan({
      legs: [{
        anchor: BASE, days: 2, mode: "car", radiusM: 5_000,
        dayAnchors: [{ dayIndex: 1, ...TOWN, label: "Nachbarstadt" }],
      }],
      detailDays: 2,
    });

    // Day one stays at the base; day two happens forty kilometres away
    // and is planned out of what is there.
    expect(stopsOf(plan, 0).every((ref) => Number(ref.split(":")[1]) <= 8)).toBe(true);
    expect(stopsOf(plan, 1).length).toBeGreaterThan(0);
    expect(stopsOf(plan, 1).every((ref) => Number(ref.split(":")[1]) >= 21)).toBe(true);
  });

  it("stays in the city the outing is about, not the car's whole range", async () => {
    // The reported case: quarters on a lake, a day trip to a city an
    // hour away, and every proposed spot twenty kilometres outside that
    // city — a theme park and a safari park, found because the day had
    // inherited the leg's driving reach after the drive was already
    // over (§4.5).
    geo.setSearchSpots(DB, [
      ...Array.from({ length: 8 }, (_, i) => spot(i + 21, TOWN)),
      // Twenty kilometres further out: inside a car's reach, outside
      // the city.
      ...Array.from({ length: 8 }, (_, i) => spot(i + 41, OUT_OF_TOWN)),
    ]);

    const { plan } = await createTripPlan({
      legs: [{
        anchor: BASE, days: 1, mode: "car",
        dayAnchors: [{ dayIndex: 0, ...TOWN, label: "Nachbarstadt" }],
      }],
      detailDays: 1,
    });

    const planned = stopsOf(plan, 0);
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every((ref) => Number(ref.split(":")[1]) < 41)).toBe(true);

    // And it is the search that stayed small, not the scoring that
    // happened to drop them: what never enters the pool cannot be
    // rescued by a filter, and what does can be proposed.
    const outing = geo.getSearchCalls()
      .filter((c) => c.query.center
        && Math.abs(c.query.center.lat - TOWN.lat) < 0.01
        && Math.abs(c.query.center.lon - TOWN.lon) < 0.01);
    expect(outing.length).toBeGreaterThan(0);
    expect(outing.every((c) => (c.query.center?.radiusM ?? 0) <= 8_000)).toBe(true);
  });

  it("still drives the valley when the day asks for it", async () => {
    // The other half: an explicit radius is an answer the table cannot
    // give, and it must survive the new default.
    geo.setSearchSpots(DB, [
      ...Array.from({ length: 8 }, (_, i) => spot(i + 41, OUT_OF_TOWN)),
    ]);

    const { plan } = await createTripPlan({
      legs: [{
        anchor: BASE, days: 1, mode: "car",
        dayAnchors: [{ dayIndex: 0, ...TOWN, label: "Nachbarstadt", radiusM: 25_000 }],
      }],
      detailDays: 1,
    });

    expect(stopsOf(plan, 0).length).toBeGreaterThan(0);
  });

  it("keeps the destination on the day, so a re-plan goes back to it", async () => {
    const { plan } = await createTripPlan({
      legs: [{
        anchor: BASE, days: 2, mode: "car",
        dayAnchors: [{ dayIndex: 1, ...TOWN, label: "Nachbarstadt", radiusM: 6_000 }],
      }],
      detailDays: 2,
    });

    const day = plan.legs[0].days[1];
    expect(day.anchor?.label).toBe("Nachbarstadt");
    expect(day.anchor?.radiusM).toBe(6_000);
    expect(plan.legs[0].days[0].anchor).toBeNull();
  });

  it("charges the drive to the day, both ways", async () => {
    const plain = await createTripPlan({
      legs: [{ anchor: BASE, days: 1, mode: "car" }],
      detailDays: 1,
    });
    const outing = await createTripPlan({
      legs: [{
        anchor: BASE, days: 1, mode: "car",
        dayAnchors: [{ dayIndex: 0, ...TOWN, label: "Nachbarstadt" }],
      }],
      detailDays: 1,
    });

    const minutes = (p: typeof plain) =>
      p.plan.legs[0].days[0].blocks.reduce((sum, b) => sum + b.budgetMinutes, 0);
    const starts = (p: typeof plain) =>
      p.plan.legs[0].days[0].blocks[0].startMinutes ?? 0;

    // The day starts later by the drive there and loses the drive back
    // off its last block: six hours, not eight.
    expect(starts(outing)).toBeGreaterThan(starts(plain));
    expect(minutes(outing)).toBeLessThan(minutes(plain));
  });

  it("goes round a lake in the way, and says which one", async () => {
    // The reported case: the quarters on one shore, the day's
    // destination on the other. The straight line says twenty
    // kilometres, the road goes round the end and says seventy — and
    // the leg limit decides what may enter the day at all, so the
    // difference is not only a number on a card.
    const clear = await createTripPlan({
      legs: [{
        anchor: BASE, days: 1, mode: "car",
        dayAnchors: [{ dayIndex: 0, ...TOWN, label: "Nachbarstadt" }],
      }],
      detailDays: 1,
    });

    geo.setWaterCrossing(DB, {
      crossedM: 3_000, widestM: 3_000, extentM: 52_000, name: "Beispielsee",
    });
    const around = await createTripPlan({
      legs: [{
        anchor: BASE, days: 1, mode: "car",
        dayAnchors: [{ dayIndex: 0, ...TOWN, label: "Nachbarstadt" }],
      }],
      detailDays: 1,
    });

    const clearAnchor = clear.plan.legs[0].days[0].anchor!;
    const aroundAnchor = around.plan.legs[0].days[0].anchor!;

    expect(aroundAnchor.travelMinutes).toBeGreaterThan(clearAnchor.travelMinutes + 10);
    // Named, so the card can answer "why two hours for twenty
    // kilometres?" instead of leaving it as a figure nobody can
    // account for.
    expect(aroundAnchor.waterAround).toBe("Beispielsee");
    // And it survives the read: a plan load must spend the same detour
    // the planning did, without asking the region database again.
    expect(aroundAnchor.waterDetourM).toBe(26_000);
  });

  it("rewalks the day around the outing, not around the quarters", async () => {
    // The day was planned around the town; hiding one of its spots
    // rewalked it from the base — so the first leg of the morning
    // became the forty-kilometre drive, and the block went over budget
    // because somebody removed a spot from it (§4.5).
    const { plan } = await createTripPlan({
      legs: [{
        anchor: BASE, days: 1, mode: "car",
        dayAnchors: [{ dayIndex: 0, ...TOWN, label: "Nachbarstadt" }],
      }],
      detailDays: 1,
    });

    const planned = stopsOf(plan, 0);
    expect(planned.length).toBeGreaterThan(1);

    const after = await hideTripSpot({ planId: plan.id, osmRef: planned[0] });
    const day = after.plan.legs[0].days[0];
    const first = day.blocks.flatMap((b) => b.stops)[0];

    // Walking distance inside one town, not the drive out to it. The
    // drive is charged to the day's frame instead, which is where it
    // belongs (§4.5).
    expect(first.travelFromPrevious.minutes).toBeLessThan(20);
    expect(day.anchor?.label).toBe("Nachbarstadt");
  });

  it("says nothing about water when the way is clear", async () => {
    const { plan } = await createTripPlan({
      legs: [{
        anchor: BASE, days: 1, mode: "car",
        dayAnchors: [{ dayIndex: 0, ...TOWN, label: "Nachbarstadt" }],
      }],
      detailDays: 1,
    });

    expect(plan.legs[0].days[0].anchor?.waterAround).toBeNull();
    expect(plan.legs[0].days[0].anchor?.waterDetourM).toBe(0);
  });

  it("stays at the base when the anchor names the quarters", async () => {
    // "We stay here" is not a day trip, and charging a zero-minute
    // drive to it would cost the day a line and nothing else.
    const { plan } = await createTripPlan({
      legs: [{ anchor: BASE, days: 1, mode: "car", dayAnchors: [{ dayIndex: 0, ...BASE }] }],
      detailDays: 1,
    });
    expect(stopsOf(plan, 0).every((ref) => Number(ref.split(":")[1]) <= 8)).toBe(true);
  });

  it("refuses a day index the leg does not have", async () => {
    await expect(createTripPlan({
      legs: [{ anchor: BASE, days: 2, dayAnchors: [{ dayIndex: 5, ...TOWN }] }],
    })).rejects.toThrow(/between 0 and 1/);
  });

  it("refuses two destinations for one day", async () => {
    await expect(createTripPlan({
      legs: [{
        anchor: BASE, days: 2,
        dayAnchors: [{ dayIndex: 1, ...TOWN }, { dayIndex: 1, ...BASE }],
      }],
    })).rejects.toThrow(/happens in one place/);
  });

  it("sends a day out and calls it home again through the endpoint", async () => {
    const created = await createTripPlan({
      legs: [{ anchor: BASE, days: 2, mode: "car", radiusM: 5_000 }],
      detailDays: 2,
    });
    const planId = created.plan.id;

    const away = await setTripDayAnchor({
      planId, dayIndex: 1, ...TOWN, label: "Nachbarstadt",
    });
    expect(away.plan.legs[0].days[1].anchor?.label).toBe("Nachbarstadt");
    expect(stopsOf(away.plan, 1).every((ref) => Number(ref.split(":")[1]) >= 21)).toBe(true);

    const home = await setTripDayAnchor({ planId, dayIndex: 1 });
    expect(home.plan.legs[0].days[1].anchor).toBeNull();
    expect(stopsOf(home.plan, 1).every((ref) => Number(ref.split(":")[1]) <= 8)).toBe(true);
  });

  it("refuses half a coordinate", async () => {
    const created = await createTripPlan({ legs: [{ anchor: BASE, days: 1 }] });
    await expect(setTripDayAnchor({ planId: created.plan.id, dayIndex: 0, lat: 43.7 }))
      .rejects.toThrow(/together/);
  });

  it("fills a day trip out of its own pool the evening before", async () => {
    // Day two is beyond the detail horizon at first. Filling it later
    // must land in the same city as filling it now — the leg's pool is
    // the quarters' one, and a Florence day built from it would be a
    // day in the wrong place.
    const created = await createTripPlan({
      legs: [{
        anchor: BASE, days: 2, mode: "car", radiusM: 5_000,
        dayAnchors: [{ dayIndex: 1, ...TOWN, label: "Nachbarstadt" }],
      }],
      detailDays: 1,
    });
    expect(created.plan.legs[0].days[1].detailed).toBe(false);

    const filled = await detailTripDay({ planId: created.plan.id, dayIndex: 1 });

    expect(stopsOf(filled.plan, 1).length).toBeGreaterThan(0);
    expect(stopsOf(filled.plan, 1).every((ref) => Number(ref.split(":")[1]) >= 21)).toBe(true);
  });
});

describe("hours the traveller named (§4.5)", () => {
  function firstStart(plan: Awaited<ReturnType<typeof createTripPlan>>["plan"]) {
    return plan.legs[0].days[0].blocks[0]?.startMinutes ?? 0;
  }

  function lastEnd(plan: Awaited<ReturnType<typeof createTripPlan>>["plan"]) {
    const blocks = plan.legs[0].days[0].blocks;
    const last = blocks[blocks.length - 1];
    return (last.startMinutes ?? 0) + last.budgetMinutes;
  }

  it("starts the day from the departure the traveller gave, not from the estimate", async () => {
    const { plan } = await createTripPlan({
      legs: [{
        anchor: BASE, days: 1, mode: "car", radiusM: 5_000,
        dayAnchors: [{ dayIndex: 0, ...TOWN, label: "Nachbarstadt", departAt: "07:00" }],
      }],
      detailDays: 1,
    });
    const anchor = plan.legs[0].days[0].anchor;
    expect(anchor?.departMinutes).toBe(7 * 60);
    // Seven o'clock plus the drive — earlier than an ordinary start
    // plus the same drive, which is the whole point of saying it.
    expect(firstStart(plan)).toBe(7 * 60 + (anchor?.travelMinutes ?? 0));
  });

  it("plans nothing past the hour they start back", async () => {
    const { plan } = await createTripPlan({
      legs: [{
        anchor: BASE, days: 1, mode: "car", radiusM: 5_000,
        dayAnchors: [{
          dayIndex: 0, ...TOWN, label: "Nachbarstadt",
          departAt: "08:00", returnAt: "16:00",
        }],
      }],
      detailDays: 1,
    });
    expect(plan.legs[0].days[0].anchor?.returnMinutes).toBe(16 * 60);
    expect(lastEnd(plan)).toBeLessThanOrEqual(16 * 60);
  });

  it("keeps the hours through the endpoint, and drops them again", async () => {
    const created = await createTripPlan({
      legs: [{ anchor: BASE, days: 2, mode: "car", radiusM: 5_000 }],
      detailDays: 2,
    });
    const planId = created.plan.id;

    const away = await setTripDayAnchor({
      planId, dayIndex: 1, ...TOWN, label: "Nachbarstadt",
      departAt: "07:30", returnAt: "17:45",
    });
    expect(away.plan.legs[0].days[1].anchor?.departMinutes).toBe(7 * 60 + 30);
    expect(away.plan.legs[0].days[1].anchor?.returnMinutes).toBe(17 * 60 + 45);

    const quiet = await setTripDayAnchor({ planId, dayIndex: 1, ...TOWN, label: "Nachbarstadt" });
    expect(quiet.plan.legs[0].days[1].anchor?.departMinutes).toBeNull();
    expect(quiet.plan.legs[0].days[1].anchor?.returnMinutes).toBeNull();
  });

  it("refuses an hour that is not one, and a return before the departure", async () => {
    const created = await createTripPlan({ legs: [{ anchor: BASE, days: 1 }] });
    const planId = created.plan.id;
    await expect(setTripDayAnchor({ planId, dayIndex: 0, ...TOWN, departAt: "morgens" }))
      .rejects.toThrow(/HH:MM/);
    await expect(
      setTripDayAnchor({ planId, dayIndex: 0, ...TOWN, departAt: "16:00", returnAt: "09:00" }),
    ).rejects.toThrow(/later than departAt/);
  });
});
