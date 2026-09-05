/**
 * Who else is on the trip (§6.2).
 *
 * The rule is narrow and easy to get backwards: the organiser holds
 * exactly three rights, and *everything else is open to everybody on
 * the trip*. A guard in the wrong place either locks a co-traveller out
 * of contributing — which is the state this replaced — or lets somebody
 * who was never invited read a plan.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan, listTripPlans, updateTripSettings } from "./plans";
import { addFind } from "./add-find";
import { inviteToTrip, listTripParticipants, removeFromTrip } from "./shares";

const WEST = { lat: 48.37, lon: 10.9 };

function spot(n: number): GeoPoiSearchSpot {
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

let organiserId = 0;
let companionId = 0;
let strangerId = 0;
/** Unique per test: users outlive a test, plans do not. */
let companionEmail = "";

/** Answer every subsequent call as this person. */
function actAs(userId: number) {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(userId),
    permissions: ["photos.view"],
  });
}

async function makeUser(email: string, name: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email, name, password_hash: "x" })
    .returning({ id: users.id });
  return row.id;
}

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = Date.now() + Math.random();
  organiserId = await makeUser(`org-${stamp}@test.invalid`, "Organisator");
  companionEmail = `mitreisend-${stamp}@test.invalid`;
  companionId = await makeUser(companionEmail, "Mitreisende");
  strangerId = await makeUser(`fremd-${stamp}@test.invalid`, "Fremde");
  actAs(organiserId);

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
  geo.setSearchSpots("nom_west", Array.from({ length: 8 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function sharedPlan() {
  const { plan } = await createTripPlan({ legs: [{ title: "Weststadt", anchor: WEST }] });
  await inviteToTrip({ planId: plan.id, email: companionEmail });
  return plan;
}

describe("who is on the trip", () => {
  it("lists the organiser first and says who they are", async () => {
    const plan = await sharedPlan();
    const { participants, youOrganise } = await listTripParticipants({ planId: plan.id });

    expect(participants.map((p) => p.role)).toEqual(["organiser", "participant"]);
    expect(participants[0].userId).toBe(organiserId);
    expect(participants[1].email).toBe(companionEmail);
    expect(youOrganise).toBe(true);
  });

  it("treats a second invitation as the same invitation", async () => {
    const plan = await sharedPlan();
    const again = await inviteToTrip({ planId: plan.id, email: companionEmail });
    expect(again.added).toBe(false);

    const { participants } = await listTripParticipants({ planId: plan.id });
    expect(participants).toHaveLength(2);
  });

  it("says so when nobody has that address", async () => {
    const plan = await sharedPlan();
    await expect(inviteToTrip({ planId: plan.id, email: "niemand@test.invalid" }))
      .rejects.toThrow(/niemand mit der Adresse/);
  });
});

describe("what a companion may do", () => {
  it("sees the trip in their own list, and can open it", async () => {
    const plan = await sharedPlan();
    actAs(companionId);

    const { plans } = await listTripPlans();
    expect(plans.map((p) => p.id)).toContain(plan.id);
    await expect(getTripPlan({ planId: plan.id })).resolves.toBeTruthy();
  });

  it("may contribute a find — that is the point of sharing (§6.2)", async () => {
    const plan = await sharedPlan();
    actAs(companionId);

    await addFind({
      planId: plan.id,
      lat: WEST.lat + 0.01,
      lon: WEST.lon,
      name: "Café Beispielhof",
      note: "beste Pastéis laut Blog",
      dwellMinutes: 30,
    });

    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(after.legs[0].pool.some((c) => c.name === "Café Beispielhof")).toBe(true);
  });

  it("may not change the frame, and is told who can", async () => {
    // One of the organiser's three rights. The message has to read as a
    // rule rather than as a fault: "permission denied" on a family
    // holiday reads as a bug.
    const plan = await sharedPlan();
    actAs(companionId);

    await expect(updateTripSettings({ planId: plan.id, pace: "relaxed" }))
      .rejects.toThrow(/angelegt hat/);
  });

  it("may not invite anybody else", async () => {
    const plan = await sharedPlan();
    actAs(companionId);
    await expect(inviteToTrip({ planId: plan.id, email: "fremd@test.invalid" }))
      .rejects.toThrow(/angelegt hat|not found/);
  });

  it("may leave without asking", async () => {
    // Needing permission to stop planning somebody else's holiday would
    // be absurd.
    const plan = await sharedPlan();
    actAs(companionId);

    const { removed } = await removeFromTrip({ planId: plan.id, userId: companionId });
    expect(removed).toBe(true);
    await expect(getTripPlan({ planId: plan.id })).rejects.toThrow(/not found/);
  });
});

describe("what somebody who was never invited may do", () => {
  it("cannot see the trip at all", async () => {
    const plan = await sharedPlan();
    actAs(strangerId);

    const { plans } = await listTripPlans();
    expect(plans.map((p) => p.id)).not.toContain(plan.id);
    await expect(getTripPlan({ planId: plan.id })).rejects.toThrow(/not found/);
  });

  it("is told the plan does not exist, not that they lack a right", async () => {
    // Confirming that a plan exists to somebody with no business
    // knowing is a leak, however small.
    const plan = await sharedPlan();
    actAs(strangerId);
    await expect(updateTripSettings({ planId: plan.id, pace: "relaxed" }))
      .rejects.toThrow(/plan not found/);
  });

  it("cannot contribute a find either", async () => {
    const plan = await sharedPlan();
    actAs(strangerId);
    await expect(addFind({
      planId: plan.id, lat: WEST.lat, lon: WEST.lon, name: "Nicht meins", dwellMinutes: 20,
    })).rejects.toThrow(/not found/);
  });
});

describe("removing people", () => {
  it("lets the organiser remove a companion", async () => {
    const plan = await sharedPlan();
    const { removed } = await removeFromTrip({ planId: plan.id, userId: companionId });
    expect(removed).toBe(true);

    actAs(companionId);
    await expect(getTripPlan({ planId: plan.id })).rejects.toThrow(/not found/);
  });

  it("refuses to remove the organiser", async () => {
    // A trip whose organiser was removed by a mis-click would have
    // nobody able to invite them back.
    const plan = await sharedPlan();
    await expect(removeFromTrip({ planId: plan.id, userId: organiserId }))
      .rejects.toThrow(/nicht entfernen/);
  });
});
