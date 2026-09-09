/**
 * Hard times on a day, added and taken off again (§4.4).
 *
 * The mechanism was always there; what these cases pin down is that
 * saying one *now* has the same consequence as saying it when the trip
 * was created — the frame moves, and the blocks move with it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan } from "./plans";
import { addTripFixpoint, removeTripFixpoint } from "./fixpoint-edit";
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
  ownerId = await makeUser(`zeiten-${stamp}@test.invalid`, "Planerin");
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

async function trip(days = 2) {
  const { plan } = await createTripPlan({ legs: [{ title: "Weststadt", anchor: WEST, days }] });
  return plan;
}

function lastDay(plan: Awaited<ReturnType<typeof trip>>) {
  return plan.legs[0].days[plan.legs[0].days.length - 1];
}

function afternoon(day: { blocks: { id: string; budgetMinutes: number }[] }) {
  return day.blocks.find((b) => b.id === "afternoon");
}

describe("saying when the last train goes", () => {
  it("shortens the afternoon of that day", async () => {
    // The whole point of a departure (§4.4): it is computed backwards
    // from the train, and what remains is the block's budget.
    const plan = await trip();
    const before = afternoon(lastDay(plan))!.budgetMinutes;

    const { plan: after } = await addTripFixpoint({
      planId: plan.id,
      dayIndex: lastDay(plan).dayIndex,
      label: "Letzter Zug",
      at: "17:45",
      kind: "departure",
      travelMinutes: 15,
    });

    expect(afternoon(lastDay(after))!.budgetMinutes).toBeLessThan(before);
  });

  it("leaves the other days alone", async () => {
    const plan = await trip();
    const firstBefore = JSON.stringify(plan.legs[0].days[0].blocks.map((b) => b.budgetMinutes));

    const { plan: after } = await addTripFixpoint({
      planId: plan.id,
      dayIndex: lastDay(plan).dayIndex,
      label: "Letzter Zug",
      at: "17:45",
      kind: "departure",
      travelMinutes: 15,
    });

    expect(JSON.stringify(after.legs[0].days[0].blocks.map((b) => b.budgetMinutes)))
      .toBe(firstBefore);
  });

  it("shows up on the day it belongs to", async () => {
    const plan = await trip();

    const { plan: after } = await addTripFixpoint({
      planId: plan.id,
      dayIndex: lastDay(plan).dayIndex,
      label: "Letzter Zug",
      at: "17:45",
      kind: "departure",
    });

    const fixpoints = lastDay(after).fixpoints;
    expect(fixpoints.map((f) => f.label)).toContain("Letzter Zug");
    expect(fixpoints[0].kind).toBe("departure");
    expect(fixpoints[0].startMinutes).toBe(17 * 60 + 45);
  });

  it("gives the day its minutes back when the train is taken off again", async () => {
    const plan = await trip();
    const before = afternoon(lastDay(plan))!.budgetMinutes;
    const { plan: framed } = await addTripFixpoint({
      planId: plan.id,
      dayIndex: lastDay(plan).dayIndex,
      label: "Letzter Zug",
      at: "17:45",
      kind: "departure",
      travelMinutes: 15,
    });

    const { plan: after } = await removeTripFixpoint({
      planId: plan.id,
      fixpointId: lastDay(framed).fixpoints[0].rowId,
    });

    expect(lastDay(after).fixpoints).toHaveLength(0);
    expect(afternoon(lastDay(after))!.budgetMinutes).toBe(before);
  });

  it("survives the next re-plan", async () => {
    // A fixpoint is the frame, and the frame is what a re-plan keeps.
    const plan = await trip();
    await addTripFixpoint({
      planId: plan.id,
      dayIndex: lastDay(plan).dayIndex,
      label: "Letzter Zug",
      at: "17:45",
      kind: "departure",
    });

    const { updateTripSettings } = await import("./plans");
    await updateTripSettings({ planId: plan.id, pace: "relaxed" });

    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(lastDay(after).fixpoints.map((f) => f.label)).toContain("Letzter Zug");
  });

  it("refuses a time that is not one", async () => {
    const plan = await trip();
    await expect(addTripFixpoint({
      planId: plan.id, dayIndex: 0, label: "Irgendwann", at: "später",
    })).rejects.toThrow(/17:45/);
  });

  it("refuses a fixpoint without a name", async () => {
    const plan = await trip();
    await expect(addTripFixpoint({
      planId: plan.id, dayIndex: 0, label: "   ", at: "17:45",
    })).rejects.toThrow(/label is required/);
  });

  it("keeps the frame to the organiser", async () => {
    // §6.2 reserves three rights, and the frame is one of them.
    const plan = await trip();
    await inviteToTrip({ planId: plan.id, email: companionEmail });
    actAs(companionId);

    await expect(addTripFixpoint({
      planId: plan.id, dayIndex: 0, label: "Führung", at: "10:00",
    })).rejects.toThrow(/angelegt hat/);
  });

  it("refuses a fixpoint from another trip", async () => {
    const plan = await trip();
    await expect(removeTripFixpoint({ planId: plan.id, fixpointId: 999_999 }))
      .rejects.toThrow(/gehört nicht zu dieser Reise/);
  });
});
