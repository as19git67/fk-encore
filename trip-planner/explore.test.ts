/**
 * Looking around a place with no trip behind it (§9.2, §20).
 *
 * What the tests are about is what would make the screen useless
 * without looking broken: a region nobody imported answering like an
 * empty area, an interest that matches by tag disappearing, and a place
 * already collected turning up as though it were new.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { ideaPool, ideaPoolShares, osmRegionImports, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { exploreArea } from "./explore";

const TOWN = { lat: 43.47, lon: 11.04 };
const NOWHERE = { lat: -20.5, lon: -70.5 };

function spot(
  n: number,
  at: { lat: number; lon: number },
  name: string,
  over: Partial<GeoPoiSearchSpot> = {},
): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: at.lat,
    lon: at.lon,
    distanceM: null,
    detourM: null,
    name,
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
    ...over,
  };
}

/** A few hundred metres east, still well inside the search radius. */
function nearby(metres: number): { lat: number; lon: number } {
  return { lat: TOWN.lat, lon: TOWN.lon + metres / 81_000 };
}

let geo: InMemoryGeoClient;
let userId: number;

beforeEach(async () => {
  await db.delete(ideaPool);
  await db.delete(ideaPoolShares);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `explore-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  userId = user.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(user.id),
    permissions: ["photos.view"],
  });
  await db.insert(osmRegionImports).values({
    slug: "europe/italy/toscana",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: "nom_toscana",
    bbox_min_lat: 42.2,
    bbox_min_lon: 9.6,
    bbox_max_lat: 44.5,
    bbox_max_lon: 12.4,
    status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("POST /trip-planner/explore", () => {
  it("answers without a query and without a trip", async () => {
    // The whole point: nothing typed, no plan id anywhere in the call.
    geo.setSearchSpots("nom_toscana", [
      spot(1, nearby(400), "Museo Civico"),
      spot(2, nearby(900), "Torre Grossa", {
        kind: "tourism=viewpoint",
        categories: ["viewpoint"],
      }),
    ]);

    const res = await exploreArea({ position: TOWN });

    expect(res.regionMissing).toBe(false);
    expect(res.spots.map((s) => s.name).sort()).toEqual(["Museo Civico", "Torre Grossa"]);
    expect(res.note).toBeNull();
    // Enough to act on: a duration the planner would allow, and the
    // distance from where the search was centred.
    expect(res.spots[0].dwellMinutes).toBeGreaterThan(0);
    expect(res.spots.every((s) => s.distanceM > 0)).toBe(true);
  });

  it("puts what the place is known for first", async () => {
    geo.setSearchSpots("nom_toscana", [
      spot(1, nearby(100), "Kapelle", { kind: "amenity=place_of_worship", categories: ["worship"] }),
      spot(2, nearby(1_200), "Dom", {
        kind: "tourism=attraction",
        categories: ["sight"],
        wikidataQid: "Q1",
        wikipedia: "it:Duomo",
      }),
    ]);

    const res = await exploreArea({ position: TOWN });

    expect(res.spots.map((s) => s.name)).toEqual(["Dom", "Kapelle"]);
    expect(res.spots[0].wikipediaUrl).toContain("wikipedia.org");
  });

  it("keeps a castle that carries no category of its own", async () => {
    // The reason the interest filter runs here and not in the region
    // query: "Burgen und Schlösser" has no category, so a query
    // narrowed by its categories would ask for nothing.
    geo.setSearchSpots("nom_toscana", [
      spot(1, nearby(300), "Rocca", { kind: "historic=castle", categories: ["sight"] }),
      spot(2, nearby(500), "Stadtmuseum"),
    ]);

    const res = await exploreArea({ position: TOWN, interests: ["castles"] });

    expect(res.spots.map((s) => s.name)).toEqual(["Rocca"]);
  });

  it("marks what is already collected instead of hiding it", async () => {
    geo.setSearchSpots("nom_toscana", [
      spot(1, nearby(300), "Museo Civico"),
      spot(2, nearby(600), "Torre Grossa"),
    ]);
    await db.insert(ideaPool).values({
      owner_id: userId,
      osm_ref: "node:1",
      name: "Museo Civico",
      lat: nearby(300).lat,
      lon: nearby(300).lon,
      category: "museum",
      dwell_minutes: 90,
    });

    const res = await exploreArea({ position: TOWN });

    expect(res.spots).toHaveLength(2);
    expect(res.spots.find((s) => s.osmRef === "node:1")?.collected).toBe(true);
    expect(res.spots.find((s) => s.osmRef === "node:2")?.collected).toBe(false);
  });

  it("marks against a shared collection when one is named", async () => {
    const [other] = await db
      .insert(users)
      .values({ email: `other-${Date.now()}@test.invalid`, name: "Anna", password_hash: "x" })
      .returning({ id: users.id });
    await db.insert(ideaPoolShares).values({ owner_id: other.id, user_id: userId });
    await db.insert(ideaPool).values({
      owner_id: other.id,
      osm_ref: "node:1",
      name: "Museo Civico",
      lat: nearby(300).lat,
      lon: nearby(300).lon,
      category: "museum",
      dwell_minutes: 90,
    });
    geo.setSearchSpots("nom_toscana", [spot(1, nearby(300), "Museo Civico")]);

    const res = await exploreArea({ position: TOWN, ownerId: other.id });

    expect(res.spots[0].collected).toBe(true);
  });

  it("does not admit a collection nobody let you into", async () => {
    const [stranger] = await db
      .insert(users)
      .values({ email: `stranger-${Date.now()}@test.invalid`, name: "X", password_hash: "x" })
      .returning({ id: users.id });
    geo.setSearchSpots("nom_toscana", [spot(1, nearby(300), "Museo Civico")]);

    await expect(exploreArea({ position: TOWN, ownerId: stranger.id }))
      .rejects.toThrow(APIError);
  });

  it("says a region is missing rather than answering 'nothing here'", async () => {
    const res = await exploreArea({ position: NOWHERE });

    expect(res.regionMissing).toBe(true);
    expect(res.spots).toEqual([]);
    expect(res.note).toContain("noch nicht importiert");
  });

  it("says the filter was too narrow when the area is not empty", async () => {
    geo.setSearchSpots("nom_toscana", [spot(1, nearby(300), "Stadtmuseum")]);

    const res = await exploreArea({ position: TOWN, interests: ["bath"] });

    expect(res.spots).toEqual([]);
    expect(res.note).toContain("passt zur Auswahl");
  });

  it("still searches by name when somebody does type one", async () => {
    geo.setSearchSpots("nom_toscana", [
      spot(1, nearby(300), "Museo Civico"),
      spot(2, nearby(400), "Torre Grossa"),
    ]);

    const res = await exploreArea({ position: TOWN, query: "Torre" });

    expect(res.spots.map((s) => s.name)).toEqual(["Torre Grossa"]);
  });

  it("refuses a single character, and not an empty field", async () => {
    geo.setSearchSpots("nom_toscana", [spot(1, nearby(300), "Museo Civico")]);

    await expect(exploreArea({ position: TOWN, query: "M" })).rejects.toThrow(APIError);
    // An empty string is what a search field holds before anybody types
    // — it means "everything", not "nothing".
    const res = await exploreArea({ position: TOWN, query: "  " });
    expect(res.spots).toHaveLength(1);
  });

  it("says when more matched than came back", async () => {
    geo.setSearchSpots(
      "nom_toscana",
      Array.from({ length: 8 }, (_, i) => spot(i + 1, nearby(100 + i * 10), `Museum ${i}`)),
    );

    const res = await exploreArea({ position: TOWN, limit: 3 });

    expect(res.spots).toHaveLength(3);
    expect(res.hasMore).toBe(true);
  });

  it("does not reach past the radius it was given", async () => {
    geo.setSearchSpots("nom_toscana", [
      spot(1, nearby(300), "Nah"),
      spot(2, nearby(9_000), "Weit"),
    ]);

    const res = await exploreArea({ position: TOWN, radiusM: 1_000 });

    expect(res.spots.map((s) => s.name)).toEqual(["Nah"]);
  });
});
