/**
 * Keeping a Live Activity current from the server (§8.5): what is sent,
 * when nothing is, and when the Activity is let go.
 *
 * Coordinates sit near a river town in Bavaria; every place is invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripLiveActivities, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan } from "./plans";
import { endLiveActivity, registerLiveActivity, setLiveActivitySender, tickLiveActivities } from "./live-activity";
import type { LiveActivityPush } from "../push/apns-payload";

const ANCHOR = { lat: 48.37, lon: 10.9 };
const DB = "nom_west";

function spot(n: number): GeoPoiSearchSpot {
  const angle = (n / 12) * 2 * Math.PI;
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: ANCHOR.lat + (400 * Math.cos(angle)) / 111_320,
    lon: ANCHOR.lon + (400 * Math.sin(angle)) / (111_320 * Math.cos((ANCHOR.lat * Math.PI) / 180)),
    distanceM: 400,
    detourM: null,
    name: `Sehenswürdigkeit ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: null,
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
let ownerId = 0;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `live-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
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
    bbox_max_lon: 11.2,
    status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  geo.setSearchSpots(DB, Array.from({ length: 12 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

const START = "2026-09-05";
const ZONE = "Europe/Berlin"; // +02:00 in September
const TOKEN = "ab".repeat(32);

/** The instant Berlin's clock shows `minutes` past midnight on `date`. */
function berlin(minutes: number, date = START): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) + (minutes - 120) * 60_000);
}

let sent: { token: string; push: LiveActivityPush }[] = [];
let answer = { status: 200 as number, reason: undefined as string | undefined };

beforeEach(() => {
  sent = [];
  answer = { status: 200, reason: undefined };
  setLiveActivitySender(async (token, _env, push) => {
    sent.push({ token, push });
    return answer;
  });
  return () => setLiveActivitySender(null);
});

async function running() {
  const { plan } = await createTripPlan({ legs: [{ anchor: ANCHOR, days: 2, startDate: START }] });
  await registerLiveActivity({ planId: plan.id, token: TOKEN, environment: "sandbox", timeZone: ZONE });
  const blocks = plan.legs[0].days[0].blocks.filter((b) => b.startMinutes !== null && b.stops.length > 0);
  expect(blocks.length).toBeGreaterThan(1);
  return { plan, first: blocks[0], second: blocks[1] };
}

describe("the Live Activity tick", () => {
  it("pushes the block the day is in, and nothing when that has not changed", async () => {
    const { first } = await running();

    await tickLiveActivities(berlin(first.startMinutes! + 1));
    expect(sent).toHaveLength(1);
    expect(sent[0].token).toBe(TOKEN);
    expect(sent[0].push.event).toBe("update");
    expect(sent[0].push.priority).toBe(10);
    expect(sent[0].push.contentState.blockLabel).toBe(first.label);
    // Stale at the block's end, on Berlin's clock.
    expect(sent[0].push.staleDate?.getTime())
      .toBe(berlin(first.startMinutes! + first.budgetMinutes).getTime());

    await tickLiveActivities(berlin(first.startMinutes! + 2));
    expect(sent).toHaveLength(1);
  });

  it("pushes again at the boundary to the next block", async () => {
    const { first, second } = await running();
    await tickLiveActivities(berlin(first.startMinutes! + 1));
    await tickLiveActivities(berlin(second.startMinutes! + 1));
    expect(sent.map((s) => s.push.contentState.blockLabel)).toEqual([first.label, second.label]);
  });

  it("ends the Activity after the day's last block and forgets it", async () => {
    const { plan, first } = await running();
    await tickLiveActivities(berlin(first.startMinutes! + 1));
    const ends = plan.legs[0].days[0].blocks.flatMap((b) =>
      b.startMinutes === null ? [] : [b.startMinutes + b.budgetMinutes]);
    await tickLiveActivities(berlin(Math.max(...ends) + 5));

    expect(sent.at(-1)?.push.event).toBe("end");
    expect(await db.select().from(tripLiveActivities)).toEqual([]);
  });

  it("says nothing before the day begins", async () => {
    const { first } = await running();
    await tickLiveActivities(berlin(first.startMinutes! - 60));
    expect(sent).toEqual([]);
    expect(await db.select().from(tripLiveActivities)).toHaveLength(1);
  });

  it("forgets an Activity Apple no longer knows", async () => {
    const { first } = await running();
    answer = { status: 410, reason: "Unregistered" };
    await tickLiveActivities(berlin(first.startMinutes! + 1));
    expect(await db.select().from(tripLiveActivities)).toEqual([]);
  });

  it("keeps the last state only when Apple took it, so a failure is retried", async () => {
    const { first } = await running();
    answer = { status: 500, reason: "InternalServerError" };
    await tickLiveActivities(berlin(first.startMinutes! + 1));
    answer = { status: 200, reason: undefined };
    await tickLiveActivities(berlin(first.startMinutes! + 2));
    expect(sent).toHaveLength(2);
  });

  it("lets the app end it, and refuses a zone or token that is not one", async () => {
    const { plan } = await running();
    await expect(registerLiveActivity({ planId: plan.id, token: TOKEN, timeZone: "Mars/Olympus" }))
      .rejects.toMatchObject({ code: "invalid_argument" });
    await expect(registerLiveActivity({ planId: plan.id, token: "nope", timeZone: ZONE }))
      .rejects.toMatchObject({ code: "invalid_argument" });
    expect(await endLiveActivity({ planId: plan.id, token: TOKEN })).toEqual({ removed: true });
    expect(await db.select().from(tripLiveActivities)).toEqual([]);
  });
});
