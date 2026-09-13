/**
 * Reading an article with no trip behind it (§9.2 case 2, §20).
 *
 * The pipeline itself is tested in `share.test.ts` and
 * `extract-places.test.ts`. What is new here is where the names get
 * looked up: a coordinate and the region under it, instead of a trip's
 * legs. So these are about that seam — that the region is found, that
 * a missing one is said plainly rather than answered with a list of
 * unplaceable names, and that a proposal comes back resolved.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { osmRegionImports, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { readArticleHere } from "./article-read";

const TOWN = { lat: 43.47, lon: 11.04 };
const NOWHERE = { lat: -20.5, lon: -70.5 };

function spot(n: number, name: string, over: Partial<GeoPoiSearchSpot> = {}): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: TOWN.lat + n / 10_000,
    lon: TOWN.lon,
    distanceM: 100,
    detourM: null,
    name,
    nameDe: null,
    nameEn: null,
    kind: "amenity=cafe",
    categories: ["cafe"],
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

/** Answer the llm-service with this, whatever it is asked. */
function stubModel(answer: unknown) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
}

const ARTICLE = [
  "Drei Orte in der Altstadt.",
  "Im Café Beispielhof gibt es den besten Kuchen der Stadt.",
].join("\n");

let geo: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `article-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
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
  geo.setSearchSpots("nom_toscana", []);
  setGeoClient(geo);
  return () => {
    resetGeoClient();
    vi.restoreAllMocks();
  };
});

describe("POST /trip-planner/explore/article", () => {
  it("resolves a name against the region under the coordinate", async () => {
    geo.setSearchSpots("nom_toscana", [spot(1, "Café Beispielhof")]);
    stubModel({
      places: [{
        name: "Café Beispielhof",
        quote: "Im Café Beispielhof gibt es den besten Kuchen der Stadt.",
      }],
    });

    const res = await readArticleHere({ position: TOWN, text: ARTICLE });

    expect(res.kind).toBe("article");
    expect(res.proposals).toHaveLength(1);
    const [proposal] = res.proposals;
    expect(proposal.verdict).toBe("unique");
    expect(proposal.osmRef).toBe("node:1");
    // The sentence that put it on the list travels with it (§9.3): a
    // proposal nobody can check is a proposal nobody should accept.
    expect(proposal.quote).toContain("besten Kuchen");
  });

  it("keeps a name the region does not know, with its quote", async () => {
    stubModel({
      places: [{ name: "Bar ohne Eintrag", quote: "Die Bar ohne Eintrag lohnt den Umweg." }],
    });

    const res = await readArticleHere({ position: TOWN, text: "Die Bar ohne Eintrag lohnt den Umweg." });

    expect(res.proposals[0].verdict).toBe("none");
    expect(res.proposals[0].position).toBeNull();
    // Not a failure — a note with its quote, which stays in view until
    // somebody resolves it by hand.
    expect(res.proposals[0].quote).toContain("lohnt den Umweg");
  });

  it("says the maps are missing rather than naming places it cannot place", async () => {
    stubModel({ places: [] });

    await expect(readArticleHere({ position: NOWHERE, text: ARTICLE }))
      .rejects.toThrow(APIError);
  });

  it("needs something to read", async () => {
    await expect(readArticleHere({ position: TOWN })).rejects.toThrow(APIError);
    await expect(readArticleHere({ position: TOWN, text: "   " })).rejects.toThrow(APIError);
  });

  it("refuses a position that is not one", async () => {
    await expect(readArticleHere({ position: { lat: 100, lon: 11 }, text: ARTICLE }))
      .rejects.toThrow(APIError);
  });

  it("says so when the page held no text at all", async () => {
    await expect(readArticleHere({ position: TOWN, text: "<html><body></body></html>" }))
      .rejects.toThrow(APIError);
  });
});
