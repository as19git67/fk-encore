/**
 * Who is coming, and what the planner does about it (§3.5).
 *
 * The three things worth pinning down: the household is offered rather
 * than taken along, adding a small child actually shortens the day
 * (otherwise the whole feature is a label), and "wer mitfährt" is the
 * organiser's call — it is the frame, not a contribution.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import {
  osmRegionImports,
  tripPlanShares,
  tripPlanTravellers,
  tripPlans,
  userSubjectPersons,
  users,
} from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan } from "./plans";
import {
  addTraveller,
  planTravellers,
  removeTraveller,
  suggestTravellers,
} from "./travellers";

const MUNICH = { lat: 48.14, lon: 11.58 };
const DB = "nom_west";
/** Far enough out that the ages are arithmetic, not a race with today. */
const START = "2027-07-01";

function spot(n: number): GeoPoiSearchSpot {
  return {
    osmRef: `way:${n}`,
    type: "way",
    id: n,
    lat: MUNICH.lat + n * 0.0006,
    lon: MUNICH.lon,
    distanceM: n * 70,
    detourM: null,
    name: `Ort ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=attraction",
    categories: ["sight"],
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

let ownerId = 0;
let otherId = 0;

async function makeUser(prefix: string, name: string, stamp: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `${prefix}-${stamp}@test.invalid`, name, password_hash: "x" })
    .returning({ id: users.id });
  return row.id;
}

function actAs(userId: number) {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(userId),
    permissions: ["photos.view"],
  });
}

/** A household entry, as the documents module keeps them. */
async function household(
  name: string,
  relationTag: string,
  birthDate: string | null,
  inHousehold = true,
): Promise<number> {
  const [row] = await db
    .insert(userSubjectPersons)
    .values({
      user_id: ownerId,
      full_name: name,
      relation_tag: relationTag,
      relation_kind: relationTag === "kind" ? "child" : "other",
      birth_date: birthDate,
      in_household: inHousehold,
    })
    .returning({ id: userSubjectPersons.id });
  return row.id;
}

async function trip(startDate: string | undefined = START) {
  const { plan } = await createTripPlan({
    legs: [{ title: "München", anchor: MUNICH, startDate }],
  });
  return plan;
}

beforeEach(async () => {
  await db.delete(tripPlanTravellers);
  await db.delete(tripPlans);
  await db.delete(userSubjectPersons);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = `${Date.now()}-${Math.random()}`;
  ownerId = await makeUser("planerin", "Planerin", stamp);
  otherId = await makeUser("mitreisender", "Mitreisender", stamp);
  actAs(ownerId);

  await db.insert(osmRegionImports).values({
    slug: "europe/west",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: DB,
    bbox_min_lat: 47.9,
    bbox_min_lon: 11.2,
    bbox_max_lat: 48.5,
    bbox_max_lon: 11.9,
    status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots(DB, Array.from({ length: 9 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("the household is offered, not taken along", () => {
  it("suggests the people who live here, with their age at the start", async () => {
    await household("Kind A", "kind", "2020-06-15");
    const plan = await trip();

    const { suggestions } = await suggestTravellers({ planId: plan.id });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].label).toBe("Kind A");
    expect(suggestions[0].ageAtStart).toBe(7);
  });

  it("leaves out somebody who does not live here", async () => {
    await household("Weit weg", "sonstige", "1970-01-01", false);
    const plan = await trip();

    expect((await suggestTravellers({ planId: plan.id })).suggestions).toEqual([]);
  });

  it("takes nobody along by itself", async () => {
    await household("Kind A", "kind", "2020-06-15");
    const plan = await trip();

    const { travellers } = await planTravellers({ planId: plan.id });

    expect(travellers).toEqual([]);
  });

  it("stops offering somebody who is already coming", async () => {
    const child = await household("Kind A", "kind", "2020-06-15");
    const plan = await trip();
    await addTraveller({ planId: plan.id, subjectPersonId: child });

    expect((await suggestTravellers({ planId: plan.id })).suggestions).toEqual([]);
  });
});

describe("a child on the trip shortens the day", () => {
  it("writes the flag into the trip and says why", async () => {
    const child = await household("Kind A", "kind", "2020-06-15");
    const plan = await trip();

    const { plan: after } = await addTraveller({ planId: plan.id, subjectPersonId: child });

    expect((after.constraints.group as Record<string, unknown>).withChildren).toBe(true);
    const { effect } = await planTravellers({ planId: plan.id });
    expect(effect.withChildren).toBe(true);
    expect(effect.reasons.join(" ")).toContain("Kind A");
  });

  it("actually plans a smaller day, not just a label", async () => {
    // §3.5's whole point: the group works on the block's time budget.
    const child = await household("Kind A", "kind", "2020-06-15");
    const plan = await trip();
    const before = budget(plan);

    const { plan: after } = await addTraveller({ planId: plan.id, subjectPersonId: child });

    expect(budget(after)).toBeLessThan(before);
  });

  it("gives the minutes back when the child stays at home", async () => {
    const child = await household("Kind A", "kind", "2020-06-15");
    const plan = await trip();
    const before = budget(plan);
    const { plan: withChild } = await addTraveller({ planId: plan.id, subjectPersonId: child });
    const [row] = await db
      .select({ id: tripPlanTravellers.id })
      .from(tripPlanTravellers)
      .where(eq(tripPlanTravellers.plan_id, plan.id));

    const { plan: after } = await removeTraveller({ planId: plan.id, travellerId: row.id });

    expect(budget(withChild)).toBeLessThan(before);
    expect(budget(after)).toBe(before);
    expect(after.constraints.group).toBeUndefined();
  });

  it("counts the age at the start, so a grown-up child changes nothing", async () => {
    const grown = await household("Kind B", "kind", "2004-06-15");
    const plan = await trip();
    const before = budget(plan);

    const { plan: after } = await addTraveller({ planId: plan.id, subjectPersonId: grown });

    expect(budget(after)).toBe(before);
    expect(after.constraints.group).toBeUndefined();
  });

  it("takes 'kürzere Wege' from the person who said it", async () => {
    const plan = await trip();

    const { plan: after } = await addTraveller({
      planId: plan.id, label: "Oma", birthDate: "1944-02-02", shortWalks: true,
    });

    expect((after.constraints.group as Record<string, unknown>).limitedMobility).toBe(true);
  });
});

describe("who may say who comes", () => {
  it("is the organiser's call, like the pace (§6.2)", async () => {
    const child = await household("Kind A", "kind", "2020-06-15");
    const plan = await trip();
    await db.insert(tripPlanShares).values({ plan_id: plan.id, user_id: otherId });

    actAs(otherId);
    await expect(addTraveller({ planId: plan.id, subjectPersonId: child }))
      .rejects.toThrow(/angelegt hat/);
  });

  it("does not take a person out of somebody else's household", async () => {
    const plan = await trip();
    actAs(otherId);
    const [stranger] = await db
      .insert(userSubjectPersons)
      .values({
        user_id: otherId, full_name: "Fremdes Kind", relation_tag: "kind",
        relation_kind: "child", birth_date: "2020-01-01", in_household: true,
      })
      .returning({ id: userSubjectPersons.id });

    actAs(ownerId);
    await expect(addTraveller({ planId: plan.id, subjectPersonId: stranger.id }))
      .rejects.toThrow(/person not found/);
  });

  it("refuses a traveller with neither a person nor a name", async () => {
    const plan = await trip();

    await expect(addTraveller({ planId: plan.id }))
      .rejects.toThrow(/subjectPersonId oder ein Name/);
  });

  it("refuses the same person twice", async () => {
    const child = await household("Kind A", "kind", "2020-06-15");
    const plan = await trip();
    await addTraveller({ planId: plan.id, subjectPersonId: child });

    await expect(addTraveller({ planId: plan.id, subjectPersonId: child }))
      .rejects.toThrow(/fährt schon mit/);
  });
});

describe("a trip without dates", () => {
  it("says it cannot compute an age instead of planning as if it had", async () => {
    const { plan } = await createTripPlan({ legs: [{ title: "München", anchor: MUNICH }] });
    await addTraveller({ planId: plan.id, label: "Kind A", birthDate: "2020-06-15" });

    const { on, effect } = await planTravellers({ planId: plan.id });

    expect(on).toBeNull();
    expect(effect.withChildren).toBe(false);
    expect(effect.reasons.join(" ")).toContain("Ohne Reisedatum");
  });
});

/** Total minutes the first day's blocks were given. */
function budget(plan: { legs: { days: { blocks: { budgetMinutes: number }[] }[] }[] }): number {
  return plan.legs[0].days[0].blocks.reduce((sum, block) => sum + block.budgetMinutes, 0);
}
