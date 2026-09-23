/**
 * Pictures along a way (§4.7).
 *
 * What these pin down is the order and the failure modes, not
 * Wikimedia: the items' chosen images come first and carry the item's
 * name, photographs along the way follow in turn along it, nothing is
 * shown twice, and an unreachable Commons or geo means no pictures —
 * never a broken screen.
 *
 * Coordinates sit near Lake Garda; every place, file, author and
 * Wikidata id is invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoRoute } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import {
  type CommonsClient,
  type CommonsPhoto,
  parseImageClaims,
  parseImageInfo,
  plainText,
} from "./commons-client";
import { createTripPlan } from "./plans";
import { clearRoutePhotoCache, MAX_ROUTE_PHOTOS, routePhotos } from "./route-photos";

vi.mock("~encore/auth", () => ({ getAuthData: vi.fn() }));

const ANCHOR = { lat: 45.88, lon: 10.84 };

function route(overrides: Partial<GeoRoute> = {}): GeoRoute {
  return {
    osmRef: "relation:7",
    id: 7,
    name: "Gipfelweg Beispiel",
    route: "hiking",
    network: "lwn",
    ref: null,
    lengthM: 10_000,
    ascentM: 600,
    distanceM: 500,
    start: { lat: ANCHOR.lat, lon: ANCHOR.lon },
    end: { lat: ANCHOR.lat + 0.07, lon: ANCHOR.lon },
    via: [
      { lat: ANCHOR.lat, lon: ANCHOR.lon },
      { lat: ANCHOR.lat + 0.035, lon: ANCHOR.lon },
      { lat: ANCHOR.lat + 0.07, lon: ANCHOR.lon },
    ],
    joined: true,
    roundtrip: false,
    website: null,
    wikipedia: null,
    difficulty: null,
    ...overrides,
  };
}

function photo(title: string): CommonsPhoto {
  return {
    title,
    thumbUrl: `https://upload.example.test/${encodeURIComponent(title)}`,
    thumbWidth: 640,
    thumbHeight: 480,
    pageUrl: `https://commons.example.test/wiki/${encodeURIComponent(title)}`,
    author: "Beispiel Fotograf",
    license: "CC BY-SA 4.0",
  };
}

/** A Commons that knows a few files and where they were taken. */
class FakeCommons implements CommonsClient {
  images = new Map<string, string>();
  /** Per sample point, keyed "lat,lon" to 3 places. */
  near = new Map<string, CommonsPhoto[]>();
  fail = false;
  calls = 0;

  async imagesOf(qids: readonly string[]): Promise<Map<string, string>> {
    this.calls += 1;
    if (this.fail) throw new Error("commons down");
    return new Map(qids.flatMap((q) => (this.images.has(q) ? [[q, this.images.get(q)!]] : [])));
  }

  async files(titles: readonly string[]): Promise<CommonsPhoto[]> {
    return titles.map(photo);
  }

  async nearby(point: { lat: number; lon: number }): Promise<CommonsPhoto[]> {
    this.calls += 1;
    if (this.fail) throw new Error("commons down");
    return this.near.get(`${point.lat.toFixed(3)},${point.lon.toFixed(3)}`) ?? [];
  }
}

let geo: InMemoryGeoClient;
let commons: FakeCommons;
let ownerId = 0;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  clearRoutePhotoCache();
  const [user] = await db
    .insert(users)
    .values({ email: `photos-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = user.id;
  vi.mocked(getAuthData).mockReturnValue({ userID: String(ownerId), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "italy/nord-est",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: "nom_garda",
    bbox_min_lat: 45.5,
    bbox_min_lon: 10.5,
    bbox_max_lat: 46.2,
    bbox_max_lon: 11.2,
    status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_garda", []);
  geo.setRoutes("nom_garda", [route()]);
  setGeoClient(geo);
  commons = new FakeCommons();
  return () => resetGeoClient();
});

async function plan() {
  const { plan } = await createTripPlan({ legs: [{ title: "Beispielstadt", anchor: ANCHOR }] });
  return plan;
}

describe("the strip", () => {
  it("puts the summit's own picture first, named after it", async () => {
    const p = await plan();
    geo.setAlongSubjects("nom_garda", 7, [
      { category: "peak", name: "Monte Beispiel", wikidata: "Q9000001", lat: ANCHOR.lat, lon: ANCHOR.lon },
      // An item without a chosen image: nothing, rather than a gap.
      { category: "castle", name: "Burg Beispiel", wikidata: "Q9000002", lat: ANCHOR.lat, lon: ANCHOR.lon },
    ]);
    commons.images.set("Q9000001", "File:Monte Beispiel.jpg");
    commons.near.set("45.880,10.840", [photo("File:Weg unten.jpg")]);

    const res = await routePhotos(ownerId, { planId: p.id, osmRef: "relation:7" }, { geo, commons });

    expect(res.photos.map((ph) => ph.caption)).toEqual(["Monte Beispiel", null]);
    expect(res.photos[0].author).toBe("Beispiel Fotograf");
    expect(res.photos[0].license).toBe("CC BY-SA 4.0");
  });

  it("walks the way rather than emptying one place first", async () => {
    const p = await plan();
    commons.near.set("45.880,10.840", [photo("File:A1.jpg"), photo("File:A2.jpg")]);
    commons.near.set("45.915,10.840", [photo("File:B1.jpg")]);
    commons.near.set("45.950,10.840", [photo("File:C1.jpg"), photo("File:C2.jpg")]);

    const res = await routePhotos(ownerId, { planId: p.id, osmRef: "relation:7" }, { geo, commons });

    expect(res.photos.map((ph) => ph.pageUrl.split("/").pop())).toEqual(
      ["File%3AA1.jpg", "File%3AB1.jpg", "File%3AC1.jpg", "File%3AA2.jpg", "File%3AC2.jpg"],
    );
  });

  it("shows a picture once, however it was found", async () => {
    const p = await plan();
    geo.setAlongSubjects("nom_garda", 7, [
      { category: "peak", name: "Monte Beispiel", wikidata: "Q9000001", lat: ANCHOR.lat, lon: ANCHOR.lon },
    ]);
    commons.images.set("Q9000001", "File:Monte_Beispiel.jpg");
    // The same file, found again by place — with the API's spaces.
    commons.near.set("45.880,10.840", [photo("File:Monte Beispiel.jpg")]);

    const res = await routePhotos(ownerId, { planId: p.id, osmRef: "relation:7" }, { geo, commons });

    expect(res.photos).toHaveLength(1);
    expect(res.photos[0].caption).toBe("Monte Beispiel");
  });

  it("stops at a strip's length", async () => {
    const p = await plan();
    commons.near.set("45.880,10.840",
      Array.from({ length: 40 }, (_, i) => photo(`File:Viele ${i}.jpg`)));
    const res = await routePhotos(ownerId, { planId: p.id, osmRef: "relation:7" }, { geo, commons });
    expect(res.photos.length).toBeLessThanOrEqual(MAX_ROUTE_PHOTOS);
  });

  it("asks Wikimedia once a day per way, not per visit", async () => {
    const p = await plan();
    commons.near.set("45.880,10.840", [photo("File:A1.jpg")]);
    let clock = 1_000;
    const deps = { geo, commons, now: () => clock };

    await routePhotos(ownerId, { planId: p.id, osmRef: "relation:7" }, deps);
    const after = commons.calls;
    await routePhotos(ownerId, { planId: p.id, osmRef: "relation:7" }, deps);
    expect(commons.calls).toBe(after);

    clock += 25 * 60 * 60 * 1000;
    await routePhotos(ownerId, { planId: p.id, osmRef: "relation:7" }, deps);
    expect(commons.calls).toBeGreaterThan(after);
  });
});

describe("the answers that are not pictures", () => {
  it("is an empty strip when Commons does not answer", async () => {
    const p = await plan();
    commons.fail = true;
    const res = await routePhotos(ownerId, { planId: p.id, osmRef: "relation:7" }, { geo, commons });
    expect(res.photos).toEqual([]);
  });

  it("is an empty strip when geo does not answer", async () => {
    const p = await plan();
    geo.failSearchFor("nom_garda");
    const res = await routePhotos(ownerId, { planId: p.id, osmRef: "relation:7" }, { geo, commons });
    expect(res.photos).toEqual([]);
  });

  it("says when a re-import dropped the way", async () => {
    const p = await plan();
    await expect(routePhotos(ownerId, { planId: p.id, osmRef: "relation:99" }, { geo, commons }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("does not hand out somebody else's plan", async () => {
    const p = await plan();
    await expect(routePhotos(ownerId + 1, { planId: p.id, osmRef: "relation:7" }, { geo, commons }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a reference that is not a relation", async () => {
    const p = await plan();
    await expect(routePhotos(ownerId, { planId: p.id, osmRef: "way:7" }, { geo, commons }))
      .rejects.toMatchObject({ code: "invalid_argument" });
  });
});

describe("reading Wikimedia's answers", () => {
  it("takes the first chosen image of each item", () => {
    const images = parseImageClaims({
      entities: {
        Q1: { claims: { P18: [{ mainsnak: { datavalue: { value: "Gipfel Beispiel.jpg" } } }] } },
        Q2: { claims: {} },
        Q3: { missing: "" },
      },
    });
    expect([...images]).toEqual([["Q1", "File:Gipfel Beispiel.jpg"]]);
  });

  it("keeps photographs and leaves maps, logos and thumbnails out", () => {
    const info = (title: string, mime: string, width: number) => ({
      title,
      imageinfo: [{
        thumburl: `https://upload.example.test/${title}`,
        thumbwidth: 640,
        thumbheight: 427,
        descriptionurl: `https://commons.example.test/${title}`,
        width,
        mime,
        extmetadata: {
          Artist: { value: "<a href=\"https://example.test\">Beispiel&nbsp;Fotograf</a>" },
          LicenseShortName: { value: "CC BY 4.0" },
        },
      }],
    });
    const photos = parseImageInfo({
      query: {
        pages: [
          info("File:Weg.jpg", "image/jpeg", 4000),
          info("File:Karte.png", "image/png", 4000),
          info("File:Wappen.svg", "image/svg+xml", 4000),
          info("File:Winzig.jpg", "image/jpeg", 300),
        ],
      },
    });
    expect(photos.map((p) => p.title)).toEqual(["File:Weg.jpg"]);
    expect(photos[0].author).toBe("Beispiel Fotograf");
    expect(photos[0].license).toBe("CC BY 4.0");
  });

  it("follows the caller's order, not the API's", () => {
    const page = (title: string) => ({
      title,
      imageinfo: [{ thumburl: "t", descriptionurl: "d", width: 2000, mime: "image/jpeg" }],
    });
    const photos = parseImageInfo(
      { query: { pages: [page("File:B b.jpg"), page("File:A a.jpg")] } },
      ["File:A_a.jpg", "File:B_b.jpg"],
    );
    expect(photos.map((p) => p.title)).toEqual(["File:A a.jpg", "File:B b.jpg"]);
  });

  it("turns credit markup into a line of text", () => {
    expect(plainText("<span>Beispiel &amp; Muster</span>")).toBe("Beispiel & Muster");
    expect(plainText("   ")).toBeNull();
    expect(plainText(undefined)).toBeNull();
    expect(plainText("x".repeat(200))!.length).toBe(80);
  });
});
