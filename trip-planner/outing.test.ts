/**
 * The collection speaking up, and the afternoon it can become (§20.2).
 *
 * Three things decide whether this helps or nags: that it stays quiet
 * about something it has just mentioned, that a "not now" is remembered
 * rather than acted on, and that several nearby ideas turn into a plan
 * with the family's own entries ahead of whatever the map offers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { ideaPool, ideaPoolShares, osmRegionImports, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { dismissIdea, ideasNearby, proposeOuting, DISMISSALS_UNTIL_QUIET } from "./outing";

const HERE = { lat: 48.14, lon: 11.58 };
const DB = "nom_west";

/** Metres east of HERE, as a coordinate. */
function east(metres: number) {
  return {
    lat: HERE.lat,
    lon: HERE.lon + metres / (111_320 * Math.cos((HERE.lat * Math.PI) / 180)),
  };
}

function spot(n: number, at: { lat: number; lon: number }): GeoPoiSearchSpot {
  return {
    osmRef: `node:${900 + n}`,
    type: "node",
    id: 900 + n,
    lat: at.lat,
    lon: at.lon,
    distanceM: 0,
    detourM: null,
    name: `Gefundener Ort ${n}`,
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

let annaId = 0;
let papaId = 0;

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

/** An idea in the collection, `metres` east of where we stand. */
async function idea(
  metres: number,
  over: Partial<typeof ideaPool.$inferInsert> = {},
): Promise<number> {
  const at = east(metres);
  const [row] = await db
    .insert(ideaPool)
    .values({
      owner_id: annaId,
      created_by: papaId,
      osm_ref: `node:${metres}`,
      name: `Idee bei ${metres} m`,
      lat: at.lat,
      lon: at.lon,
      category: "sight",
      dwell_minutes: 45,
      ...over,
    })
    .returning({ id: ideaPool.id });
  return row.id;
}

beforeEach(async () => {
  await db.delete(ideaPoolShares);
  await db.delete(ideaPool);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = Date.now() + Math.random();
  annaId = await makeUser(`anna-${stamp}@test.invalid`, "Anna");
  papaId = await makeUser(`papa-${stamp}@test.invalid`, "Papa");
  actAs(annaId);

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
  geo.setSearchSpots(DB, [spot(1, east(800)), spot(2, east(1_600))]);
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("is anything we collected near here?", () => {
  it("answers with the nearest first, and who put it there", async () => {
    await idea(3_000);
    await idea(500);

    const { ideas } = await ideasNearby({ ...HERE });

    expect(ideas.map((i) => i.distanceM)).toEqual([...ideas.map((i) => i.distanceM)].sort((a, b) => a - b));
    expect(ideas[0].addedBy).toBe("Papa");
  });

  it("leaves out what is simply too far", async () => {
    await idea(50_000);

    expect((await ideasNearby({ ...HERE })).ideas).toEqual([]);
  });

  it("says it once, not twice in the same week", async () => {
    // Mentioning the same beer garden on Tuesday and again on Wednesday
    // is nagging (§6.4).
    await idea(500);

    expect((await ideasNearby({ ...HERE })).ideas).toHaveLength(1);
    const second = await ideasNearby({ ...HERE });

    expect(second.ideas).toEqual([]);
    expect(second.quiet).toBe(1);
  });

  it("can look without counting as having told", async () => {
    // The list-by-distance screen is not the same thing as the app
    // speaking up, and it must not use up the one mention.
    await idea(500);

    await ideasNearby({ ...HERE, markSuggested: false });

    expect((await ideasNearby({ ...HERE })).ideas).toHaveLength(1);
  });

  it("stops offering what has been waved away often enough", async () => {
    const id = await idea(500);
    for (let i = 0; i < DISMISSALS_UNTIL_QUIET; i += 1) {
      await dismissIdea({ id });
    }

    const { ideas, quiet } = await ideasNearby({ ...HERE });

    expect(ideas).toEqual([]);
    expect(quiet).toBe(1);
    // Still collected, though: "not now" is not "delete this".
    const rows = await db.select().from(ideaPool).where(eq(ideaPool.id, id));
    expect(rows).toHaveLength(1);
  });

  it("says nothing about an exhibition that has closed", async () => {
    await idea(500, { valid_to: "2020-01-01" });

    expect((await ideasNearby({ ...HERE })).ideas).toEqual([]);
  });

  it("says nothing yet about one that has not opened", async () => {
    await idea(500, { valid_from: "2099-01-01" });

    expect((await ideasNearby({ ...HERE })).ideas).toEqual([]);
  });
});

describe("shall I make an afternoon of it?", () => {
  it("turns several nearby ideas into a plan", async () => {
    await idea(500);
    await idea(1_200);
    await idea(2_000);

    const outing = await proposeOuting({ ...HERE, mode: "car", fillFromRegion: false });

    expect(outing.offered).toBe(true);
    expect(outing.reason).toBe("ok");
    expect(outing.stops.length).toBeGreaterThan(1);
    expect(outing.stops.every((stop) => stop.fromIdeas)).toBe(true);
    expect(outing.usedMinutes).toBeLessThanOrEqual(outing.budgetMinutes);
  });

  it("puts what the family collected ahead of what the map offers", async () => {
    // §7.2's ordering: "was die Familie selbst gemerkt hat, steht vor
    // dem, was OpenStreetMap anbietet".
    await idea(500);

    const outing = await proposeOuting({ ...HERE, mode: "car", budgetMinutes: 90 });

    expect(outing.stops[0].fromIdeas).toBe(true);
    expect(outing.stops[0].addedBy).toBe("Papa");
  });

  it("marks the ones it found rather than passing them off as ours", async () => {
    await idea(500);

    const outing = await proposeOuting({ ...HERE, mode: "car", budgetMinutes: 600 });

    const found = outing.stops.filter((stop) => !stop.fromIdeas);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((stop) => stop.addedBy === null)).toBe(true);
  });

  it("says there is nothing to offer rather than proposing an empty day", async () => {
    const outing = await proposeOuting({
      lat: 10, lon: 10, mode: "car", fillFromRegion: false,
    });

    expect(outing.offered).toBe(false);
    expect(outing.reason).toBe("no-ideas");
    expect(outing.stops).toEqual([]);
  });

  it("counts what did not fit rather than quietly dropping it", async () => {
    for (let i = 1; i <= 8; i += 1) await idea(i * 900, { dwell_minutes: 120 });

    const outing = await proposeOuting({
      ...HERE, mode: "car", budgetMinutes: 120, fillFromRegion: false,
    });

    expect(outing.leftOut).toBeGreaterThan(0);
  });

  it("works from a stated area rather than where somebody stands", async () => {
    // A free Saturday: the trigger is the time, and the place is given.
    // Fifteen kilometres is well past the default nearby radius and
    // still inside what the planner's city-speed car model can reach in
    // half a day (§14 — travel times are estimates, and this is where
    // that shows).
    await idea(15_000);

    const outing = await proposeOuting({
      ...HERE, radiusM: 50_000, mode: "car", fillFromRegion: false,
    });

    expect(outing.stops.map((s) => s.name)).toContain("Idee bei 15000 m");
  });

  it("does not open somebody else's collection", async () => {
    actAs(papaId);

    await expect(proposeOuting({ ...HERE, ownerId: annaId }))
      .rejects.toThrow(/existiert nicht/);
  });
});
