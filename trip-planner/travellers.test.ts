/**
 * Who is coming, and what the planner does about it (§3.5).
 *
 * The three things worth pinning down: whoever plans the trip is on it
 * (and nobody else with an account is), adding a small child actually
 * shortens the day (otherwise the whole feature is a label), and "wer
 * mitfährt" is the organiser's call — it is the frame, not a
 * contribution.
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
import { createTripPlan, getTripPlan } from "./plans";
import { loadPlan } from "./plan-store";
import { inviteToTrip, removeFromTrip } from "./shares";
import {
  addTraveller,
  planTravellers,
  removeTraveller,
  updateTraveller,
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
  relationKind: "self" | "spouse" | "child" | "other" = relationTag === "kind" ? "child" : "other",
): Promise<number> {
  const [row] = await db
    .insert(userSubjectPersons)
    .values({
      user_id: ownerId,
      full_name: name,
      relation_tag: relationTag,
      relation_kind: relationKind,
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

describe("whoever plans the trip is on it", () => {
  it("has the organiser on the trip from the start, as their account", async () => {
    const plan = await trip();

    const { travellers } = await planTravellers({ planId: plan.id });

    expect(travellers).toHaveLength(1);
    expect(travellers[0].userId).toBe(ownerId);
    expect(travellers[0].label).toBe("Planerin");
  });

  it("puts a fellow planner on the trip with the invitation, and takes them off with it", async () => {
    // An adult with a login is a person on the trip (§3.5, §6.2):
    // there is no second list to type them into, and nothing to match
    // by name.
    const plan = await trip();

    await inviteToTrip({ planId: plan.id, userId: otherId });
    let { travellers } = await planTravellers({ planId: plan.id });
    expect(travellers.map((t) => t.userId)).toEqual([ownerId, otherId]);
    expect(travellers[1].label).toBe("Mitreisender");

    await removeFromTrip({ planId: plan.id, userId: otherId });
    ({ travellers } = await planTravellers({ planId: plan.id }));
    expect(travellers.map((t) => t.userId)).toEqual([ownerId]);
  });

  it("shows an account by its live name, not the name it joined with", async () => {
    const plan = await trip();
    await planTravellers({ planId: plan.id });

    await db.update(users).set({ name: "Planerin Beispiel" }).where(eq(users.id, ownerId));

    const { travellers } = await planTravellers({ planId: plan.id });
    expect(travellers[0].label).toBe("Planerin Beispiel");
  });

  it("takes an account's birth date from its own household, and plans with it", async () => {
    // Every account keeps a household of its own with a `self` entry;
    // the date there is theirs, and a correction lands there.
    await household("Planerin Beispiel", "selbst", "2020-06-15", true, "self");
    const plan = await trip();

    const { travellers, effect } = await planTravellers({ planId: plan.id });

    expect(travellers[0].birthDate).toBe("2020-06-15");
    expect(travellers[0].birthDateFromHousehold).toBe(true);
    expect(travellers[0].ageAtStart).toBe(7);
    expect(effect.withChildren).toBe(true);
  });

  it("does not take a birth date from somebody else's entry in the household", async () => {
    // The organiser's household lists the spouse with a date; that is
    // not the organiser's date, and not the spouse's account's either.
    await household("Mitreisender Beispiel", "Ehemann", "1984-05-06", true, "spouse");
    const plan = await trip();
    await inviteToTrip({ planId: plan.id, userId: otherId });

    const { travellers } = await planTravellers({ planId: plan.id });

    expect(travellers.every((t) => t.birthDate === null)).toBe(true);
  });

  it("cannot take a planner off the trip here — that is the invitation's job", async () => {
    const plan = await trip();
    const { travellers } = await planTravellers({ planId: plan.id });

    await expect(removeTraveller({ planId: plan.id, travellerId: travellers[0].id }))
      .rejects.toThrow(/Planen mit/);
  });

  it("keeps a planner's name to the account", async () => {
    const plan = await trip();
    const { travellers } = await planTravellers({ planId: plan.id });

    await expect(updateTraveller({
      planId: plan.id, travellerId: travellers[0].id, label: "Anders",
    })).rejects.toThrow(/aus dem Konto/);
  });

  it("lets 'mehr Zeit' be said about a planner, and a birth date their household lacks", async () => {
    const plan = await trip();
    const { travellers } = await planTravellers({ planId: plan.id });

    const { plan: after } = await updateTraveller({
      planId: plan.id, travellerId: travellers[0].id, shortWalks: true, birthDate: "1944-02-02",
    });

    expect((after.constraints.group as Record<string, unknown>).limitedMobility).toBe(true);
    const { travellers: again } = await planTravellers({ planId: plan.id });
    expect(again[0].shortWalks).toBe(true);
    expect(again[0].birthDate).toBe("1944-02-02");
    expect(again[0].birthDateFromHousehold).toBe(false);
  });

  it("leaves a birth date the household knows to the household", async () => {
    await household("Planerin Beispiel", "selbst", "1985-03-02", true, "self");
    const plan = await trip();
    const { travellers } = await planTravellers({ planId: plan.id });

    await expect(updateTraveller({
      planId: plan.id, travellerId: travellers[0].id, birthDate: "1990-01-01",
    })).rejects.toThrow(/eigenen Haushalt/);
  });

  it("re-plans the days when a planner joins or leaves", async () => {
    // Somebody whose own household says they are a child shortens the
    // day the moment they are invited, and gives it back when they go.
    actAs(otherId);
    await db.insert(userSubjectPersons).values({
      user_id: otherId, full_name: "Mitreisender Beispiel", relation_tag: "selbst",
      relation_kind: "self", birth_date: "2020-06-15", in_household: true,
    });
    actAs(ownerId);
    const plan = await trip();
    const before = budget(plan);

    await inviteToTrip({ planId: plan.id, userId: otherId });
    const { plan: withChild } = await getTripPlan({ planId: plan.id });
    expect(budget(withChild)).toBeLessThan(before);

    await removeFromTrip({ planId: plan.id, userId: otherId });
    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(budget(after)).toBe(before);
  });
});

describe("somebody without an account is entered by hand", () => {
  it("is on the trip with their name, and their age at the start", async () => {
    const plan = await trip();

    await addTraveller({ planId: plan.id, label: "Kind A", birthDate: "2020-06-15" });

    const { travellers } = await planTravellers({ planId: plan.id });
    const child = travellers.find((t) => t.label === "Kind A");
    expect(child?.userId).toBeNull();
    expect(child?.ageAtStart).toBe(7);
  });

  it("refuses a traveller without a name", async () => {
    const plan = await trip();

    await expect(addTraveller({ planId: plan.id, label: "  " }))
      .rejects.toThrow(/ein Name/);
  });

  it("refuses a birth date that is not a date", async () => {
    const plan = await trip();

    await expect(addTraveller({ planId: plan.id, label: "Kind A", birthDate: "15.06.2020" }))
      .rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe("a child on the trip shortens the day", () => {
  const child = { label: "Kind A", birthDate: "2020-06-15" };

  it("writes the flag into the trip and says why", async () => {
    const plan = await trip();

    const { plan: after } = await addTraveller({ planId: plan.id, ...child });

    expect((after.constraints.group as Record<string, unknown>).withChildren).toBe(true);
    const { effect } = await planTravellers({ planId: plan.id });
    expect(effect.withChildren).toBe(true);
    expect(effect.reasons.join(" ")).toContain("Kind A");
  });

  it("actually plans a smaller day, not just a label", async () => {
    // §3.5's whole point: the group works on the block's time budget.
    const plan = await trip();
    const before = budget(plan);

    const { plan: after } = await addTraveller({ planId: plan.id, ...child });

    expect(budget(after)).toBeLessThan(before);
  });

  it("gives the minutes back when the child stays at home", async () => {
    const plan = await trip();
    const before = budget(plan);
    const { plan: withChild } = await addTraveller({ planId: plan.id, ...child });
    const { travellers } = await planTravellers({ planId: plan.id });
    const row = travellers.find((t) => t.label === "Kind A")!;

    const { plan: after } = await removeTraveller({ planId: plan.id, travellerId: row.id });

    expect(budget(withChild)).toBeLessThan(before);
    expect(budget(after)).toBe(before);
    expect(after.constraints.group).toBeUndefined();
  });

  it("counts the age at the start, so a grown-up child changes nothing", async () => {
    const plan = await trip();
    const before = budget(plan);

    const { plan: after } = await addTraveller({
      planId: plan.id, label: "Kind B", birthDate: "2004-06-15",
    });

    expect(budget(after)).toBe(before);
    expect(after.constraints.group).toBeUndefined();
  });

  it("takes 'mehr Zeit' from the person who said it", async () => {
    const plan = await trip();

    const { plan: after } = await addTraveller({
      planId: plan.id, label: "Oma", birthDate: "1944-02-02", shortWalks: true,
    });

    expect((after.constraints.group as Record<string, unknown>).limitedMobility).toBe(true);
  });
});

describe("changing what is known about a traveller", () => {
  it("lets 'mehr Zeit' be said afterwards, and replans", async () => {
    // The flag was settable only while adding, and nobody asked then.
    const plan = await trip();
    const { plan: withOma } = await addTraveller({
      planId: plan.id, label: "Oma", birthDate: "1944-02-02",
    });
    expect((withOma.constraints.group as Record<string, unknown> | undefined)?.limitedMobility).toBeFalsy();
    const { travellers } = await planTravellers({ planId: plan.id });
    const oma = travellers.find((t) => t.label === "Oma")!;

    const { plan: after } = await updateTraveller({
      planId: plan.id, travellerId: oma.id, shortWalks: true,
    });

    expect((after.constraints.group as Record<string, unknown>).limitedMobility).toBe(true);
    const { travellers: again } = await planTravellers({ planId: plan.id });
    expect(again.find((t) => t.id === oma.id)?.shortWalks).toBe(true);
  });

  it("renames and re-dates somebody entered by hand", async () => {
    const plan = await trip();
    await addTraveller({ planId: plan.id, label: "Freundin" });
    const { travellers } = await planTravellers({ planId: plan.id });
    const friend = travellers.find((t) => t.label === "Freundin")!;

    await updateTraveller({
      planId: plan.id, travellerId: friend.id, label: "Tante", birthDate: "1970-05-05",
    });

    const { travellers: after } = await planTravellers({ planId: plan.id });
    const aunt = after.find((t) => t.id === friend.id)!;
    expect(aunt.label).toBe("Tante");
    expect(aunt.birthDate).toBe("1970-05-05");
    expect(aunt.ageAtStart).toBe(57);
  });

  it("is the organiser's call too", async () => {
    const plan = await trip();
    await addTraveller({ planId: plan.id, label: "Oma" });
    const { travellers } = await planTravellers({ planId: plan.id });
    const oma = travellers.find((t) => t.label === "Oma")!;
    await db.insert(tripPlanShares).values({ plan_id: plan.id, user_id: otherId });

    actAs(otherId);
    await expect(updateTraveller({
      planId: plan.id, travellerId: oma.id, shortWalks: true,
    })).rejects.toThrow(/angelegt hat/);
  });

  it("refuses an empty name and an empty change", async () => {
    const plan = await trip();
    await addTraveller({ planId: plan.id, label: "Oma" });
    const { travellers } = await planTravellers({ planId: plan.id });
    const oma = travellers.find((t) => t.label === "Oma")!;

    await expect(updateTraveller({ planId: plan.id, travellerId: oma.id, label: "  " }))
      .rejects.toThrow(/nicht leer/);
    await expect(updateTraveller({ planId: plan.id, travellerId: oma.id }))
      .rejects.toThrow(/nichts zu ändern/);
  });
});

describe("who may say who comes", () => {
  it("is the organiser's call, like the pace (§6.2)", async () => {
    const plan = await trip();
    await db.insert(tripPlanShares).values({ plan_id: plan.id, user_id: otherId });

    actAs(otherId);
    await expect(addTraveller({ planId: plan.id, label: "Kind A", birthDate: "2020-06-15" }))
      .rejects.toThrow(/angelegt hat/);
  });

  it("does not let a fellow planner take somebody off", async () => {
    const plan = await trip();
    await addTraveller({ planId: plan.id, label: "Oma" });
    const { travellers } = await planTravellers({ planId: plan.id });
    const oma = travellers.find((t) => t.label === "Oma")!;
    await db.insert(tripPlanShares).values({ plan_id: plan.id, user_id: otherId });

    actAs(otherId);
    await expect(removeTraveller({ planId: plan.id, travellerId: oma.id }))
      .rejects.toThrow(/angelegt hat/);
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

describe("how somebody gets about (§3.5)", () => {
  it("defaults to on foot, which is the answer nobody has to give", async () => {
    const plan = await trip();
    await addTraveller({ planId: plan.id, label: "Oma Beispiel" });

    const { travellers, effect } = await planTravellers({ planId: plan.id });

    expect(travellers.find((t) => t.label === "Oma Beispiel")?.getsAbout).toBe("foot");
    expect(effect.onWheels).toBe(false);
  });

  it("takes a wheelchair in, and says what it rules out", async () => {
    const plan = await trip();
    await addTraveller({
      planId: plan.id,
      label: "Oma Beispiel",
      getsAbout: "wheelchair",
    });

    const { travellers, effect } = await planTravellers({ planId: plan.id });

    expect(travellers.find((t) => t.label === "Oma Beispiel")?.getsAbout).toBe("wheelchair");
    expect(effect.onWheels).toBe(true);
    expect(effect.reasons.join(" ")).toContain("Strecken mit Anstieg");
  });

  it("can be changed afterwards, like everything else about a person", async () => {
    const plan = await trip();
    await addTraveller({ planId: plan.id, label: "Oma Beispiel" });
    const before = await planTravellers({ planId: plan.id });
    const oma = before.travellers.find((t) => t.label === "Oma Beispiel")!;

    await updateTraveller({ planId: plan.id, travellerId: oma.id, getsAbout: "pram" });

    const { travellers, effect } = await planTravellers({ planId: plan.id });
    expect(travellers.find((t) => t.id === oma.id)?.getsAbout).toBe("pram");
    expect(effect.onWheels).toBe(true);
  });

  it("does not shorten the day — that is a different question", async () => {
    // A wheelchair rules a route out; it does not mean less programme
    // (§4.7). Only "mehr Zeit einplanen" does that.
    const plan = await trip();
    const before = budget((await addTraveller({
      planId: plan.id,
      label: "Oma Beispiel",
      getsAbout: "wheelchair",
    })).plan);

    const plain = await trip();
    await addTraveller({ planId: plain.id, label: "Oma Beispiel" });
    const after = budget((await getTripPlan({ planId: plain.id })).plan);

    expect(before).toBe(after);
  });

  it("carries the fact into the trip, where a route can read it", async () => {
    // The derivation is only worth having if it reaches the plan: the
    // route search reads `constraints.group` and nothing else (§4.7).
    const plan = await trip();
    await addTraveller({ planId: plan.id, label: "Oma Beispiel", getsAbout: "wheelchair" });

    const stored = await loadPlan(plan.id, ownerId);
    expect((stored?.constraints.group as { onWheels?: boolean })?.onWheels).toBe(true);
  });

  it("refuses a mode nobody defined", async () => {
    const plan = await trip();
    await expect(addTraveller({ planId: plan.id, label: "X", getsAbout: "hoverboard" }))
      .rejects.toThrow(/getsAbout/);
  });
});
