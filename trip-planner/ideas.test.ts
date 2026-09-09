/**
 * The pool without a trip (§20).
 *
 * Two properties make this more than a shopping list, and both are what
 * these cases hold onto: it is **one shared list** rather than a copy
 * per person, and every entry keeps **who put it there** — "Papa wollte
 * da hin" is half the information. The rest is the way in from §9.2,
 * which must behave exactly as it does for a find: match OpenStreetMap
 * when possible, ask for a duration when not, merge a second mention
 * rather than collecting the same beer garden twice.
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
import { addIdea, listIdeas, removeIdea, shareIdeas, unshareIdeas } from "./ideas";

const BIERGARTEN = { lat: 48.14, lon: 11.58 };
const DB = "nom_west";

function spot(over: Partial<GeoPoiSearchSpot> = {}): GeoPoiSearchSpot {
  return {
    osmRef: "node:1",
    type: "node",
    id: 1,
    lat: BIERGARTEN.lat,
    lon: BIERGARTEN.lon,
    distanceM: 5,
    detourM: null,
    name: "Biergarten am Beispielweg",
    nameDe: null,
    nameEn: null,
    kind: "amenity=biergarten",
    categories: ["food"],
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
    ...over,
  };
}

let annaId = 0;
let papaId = 0;
let strangerId = 0;
let papaEmail = "";

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
  await db.delete(ideaPoolShares);
  await db.delete(ideaPool);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = Date.now() + Math.random();
  annaId = await makeUser(`anna-${stamp}@test.invalid`, "Anna");
  papaEmail = `papa-${stamp}@test.invalid`;
  papaId = await makeUser(papaEmail, "Papa");
  strangerId = await makeUser(`fremd-${stamp}@test.invalid`, "Fremde");
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
  geo.setSearchSpots(DB, [spot()]);
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("collecting an idea", () => {
  it("takes a place the map knows and fills in what it says", async () => {
    const { entry, matchedOsmRef, unknown } = await addIdea({
      ...BIERGARTEN,
      note: "Soll den besten Schatten haben",
      sourceUrl: "https://example.test/biergaerten",
    });

    expect(matchedOsmRef).toBe("node:1");
    expect(entry.category).toBe("food");
    expect(entry.dwellMinutes).toBeGreaterThan(0);
    expect(entry.unmatched).toBe(false);
    expect(entry.note).toBe("Soll den besten Schatten haben");
    expect(unknown).toEqual([]);
  });

  it("asks how long rather than inventing a duration", async () => {
    // The one question §9.2 permits, and only when the map has nothing.
    await expect(addIdea({ lat: 47.0, lon: 9.0, name: "Geheimer Wasserfall" }))
      .rejects.toThrow(/dwellMinutes/);
  });

  it("keeps a place the map does not know, and says what is missing", async () => {
    const { entry, unknown } = await addIdea({
      lat: 47.0,
      lon: 9.0,
      name: "Geheimer Wasserfall",
      dwellMinutes: 60,
    });

    expect(entry.unmatched).toBe(true);
    expect(entry.category).toBe("unknown");
    expect(unknown).toEqual(["Öffnungszeiten", "Kategorie"]);
  });

  it("remembers who put it there", async () => {
    await addIdea({ ...BIERGARTEN });

    const { entries } = await listIdeas({});

    expect(entries[0].addedBy).toBe("Anna");
  });

  it("folds a second mention into the first", async () => {
    await addIdea({ ...BIERGARTEN, note: "Schöner Schatten" });

    const second = await addIdea({
      ...BIERGARTEN,
      sourceUrl: "https://example.test/artikel",
    });

    expect(second.merged).toBe(true);
    const { entries } = await listIdeas({});
    expect(entries).toHaveLength(1);
    // What the first mention said survives the second.
    expect(entries[0].note).toBe("Schöner Schatten");
    expect(entries[0].sourceUrl).toBe("https://example.test/artikel");
  });

  it("takes a window for something that ends", async () => {
    const { entry } = await addIdea({
      ...BIERGARTEN,
      validFrom: "2026-07-01",
      validTo: "2026-09-30",
    });

    expect(entry.validFrom).toBe("2026-07-01");
    expect(entry.validTo).toBe("2026-09-30");
  });

  it("refuses a window that ends before it starts", async () => {
    await expect(addIdea({ ...BIERGARTEN, validFrom: "2026-09-30", validTo: "2026-07-01" }))
      .rejects.toThrow(/validTo/);
  });
});

describe("one list, not a copy per person", () => {
  it("lets somebody who was let in write into it", async () => {
    await addIdea({ ...BIERGARTEN, note: "Von Anna" });
    await shareIdeas({ email: papaEmail });

    actAs(papaId);
    const { entries, collections } = await listIdeas({ ownerId: annaId });

    expect(entries).toHaveLength(1);
    expect(collections.map((c) => c.ownerId)).toContain(annaId);
    expect(collections.find((c) => c.ownerId === annaId)?.ownerName).toBe("Anna");

    await addIdea({ ownerId: annaId, lat: 47.0, lon: 9.0, name: "Papas Wanderung",
                    dwellMinutes: 180 });
    actAs(annaId);
    const after = await listIdeas({});
    expect(after.entries.map((e) => e.addedBy).sort()).toEqual(["Anna", "Papa"]);
  });

  it("does not admit that somebody else's collection exists", async () => {
    await addIdea({ ...BIERGARTEN });

    actAs(strangerId);

    // Not "permission denied": a collection nobody let you into is not
    // yours to know about.
    await expect(listIdeas({ ownerId: annaId })).rejects.toThrow(/existiert nicht/);
  });

  it("takes somebody out again", async () => {
    await shareIdeas({ email: papaEmail });
    await unshareIdeas({ userId: papaId });

    actAs(papaId);
    await expect(listIdeas({ ownerId: annaId })).rejects.toThrow(/existiert nicht/);
  });

  it("refuses to share a collection with its own owner", async () => {
    const [me] = await db.select({ email: users.email }).from(users)
      .where(eq(users.id, annaId));
    await expect(shareIdeas({ email: me.email })).rejects.toThrow(/gehört dir bereits/);
  });
});

describe("taking an idea out", () => {
  it("removes it for everybody, because it is one list", async () => {
    const { entry } = await addIdea({ ...BIERGARTEN });
    await shareIdeas({ email: papaEmail });

    actAs(papaId);
    const { removed } = await removeIdea({ id: entry.id, ownerId: annaId });

    expect(removed).toBe(true);
    actAs(annaId);
    expect((await listIdeas({})).entries).toEqual([]);
  });

  it("says so plainly when there was nothing to remove", async () => {
    expect(await removeIdea({ id: 987654 })).toEqual({ removed: false });
  });
});
