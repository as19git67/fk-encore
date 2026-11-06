/**
 * The pool is ranked by how well known its places are (candidate
 * ranking plan, stage 1), looked up once and cached per place.
 *
 * Every place, id and number here is invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, tripSpotFame, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan } from "./plans";
import { resetFameClient, setFameClient, type FameClient, type ItemFacts } from "./fame-client";
import { articleOf, fameFor, imagesFor, prominenceAround, refillSpotFame } from "./spot-fame";
import type { CommonsPhoto } from "./commons-client";
import { getTripPlan } from "./plans";
import { galleryOf } from "./spot-gallery";
import { toCandidates } from "./candidates";

const CITY = { lat: 48.37, lon: 10.9 };

function sight(n: number, offset: number, name: string): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`, type: "node", id: n,
    lat: CITY.lat + offset, lon: CITY.lon, distanceM: 100, detourM: null,
    name, nameDe: null, nameEn: null,
    kind: "tourism=attraction", categories: ["sight"],
    wikidataQid: `Q99900${n}`, wikipedia: `de:${name}`,
    openingHours: null, cuisine: null, wheelchair: null, outdoorSeating: null,
    dietVegetarian: null, dietVegan: null, phone: null, website: null, facadeAzimuth: null,
  };
}

class FakeFame implements FameClient {
  calls = 0;
  views = new Map<string, number>();
  broken = false;
  async items(qids: readonly string[]) {
    this.calls += 1;
    if (this.broken) throw new Error("down");
    return new Map<string, ItemFacts>(qids.map((q) => [q, {
      languages: 5, commonsCategory: null, image: q === "Q999002" ? "File:Rathaus von Norden.jpg" : null,
    }]));
  }
  async pageImages(_lang: string, titles: readonly string[]) {
    return new Map(titles.filter((t) => t === "Musterdom").map((t) => [t, "File:Musterdom Westfassade.jpg"]));
  }
  async photos(titles: readonly string[]) { return titles.map(photo); }
  near: CommonsPhoto[] = [];
  async photosNear() { return this.near; }
  async pageviews(_lang: string, title: string) { return this.views.get(title) ?? 0; }
  async categorySizes() { return new Map<string, number>(); }
  async voyageListings() {
    return { page: "https://de.wikivoyage.org/wiki/Musterstadt", listings: [
      { name: "Musterdom", qid: "Q999003", lat: null, lon: null, description: "Gotischer Dom." },
    ] };
  }
}

function photo(title: string): CommonsPhoto {
  return {
    title, thumbUrl: `https://upload.example.test/${encodeURIComponent(title)}`, thumbWidth: 640, thumbHeight: 480,
    pageUrl: `https://commons.example.test/wiki/${encodeURIComponent(title)}`, author: "Beispiel Fotograf", license: "CC BY-SA 4.0",
  };
}

let fake: FakeFame;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(tripSpotFame);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db.insert(users)
    .values({ email: `fame-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "europe/test", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_test",
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.2, status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_test", [
    sight(1, 0.001, "Kapelle am Markt"),
    sight(2, 0.002, "Rathaus Musterstadt"),
    sight(3, 0.003, "Musterdom"),
  ]);
  setGeoClient(geo);
  fake = new FakeFame();
  fake.views = new Map([["Kapelle am Markt", 40], ["Rathaus Musterstadt", 900], ["Musterdom", 25_000]]);
  setFameClient(fake);
  return () => {
    resetGeoClient();
    resetFameClient();
  };
});

describe("ranking a pool by open data", () => {
  it("orders the pool by how well known its places are, and says why", async () => {
    const { plan } = await createTripPlan({ legs: [{ title: "Musterstadt", anchor: CITY, days: 1 }] });
    const leg = plan.legs[0];
    const all = [
      ...leg.pool,
      ...leg.days.flatMap((d) => d.blocks.flatMap((b) => b.stops)),
    ] as Array<{ osmRef: string; score?: number; reasons?: string[] }>;
    const dom = all.find((c) => c.osmRef === "node:3")!;
    const kapelle = all.find((c) => c.osmRef === "node:1")!;
    expect(dom.reasons).toContain("in Wikivoyage genannt");
    expect(dom.reasons).toContain("25.000 Aufrufe im Monat");
    expect(dom.reasons).not.toContain("in Wikidata verzeichnet");
    expect(kapelle.reasons).not.toContain("40 Aufrufe im Monat");
  });

  it("scores the better known place higher", async () => {
    const spots = [sight(1, 0.001, "Kapelle am Markt"), sight(3, 0.003, "Musterdom")];
    const scored = toCandidates(spots, { prominence: await prominenceAround(spots, CITY), requireProminence: true });
    const score = (ref: string) => scored.find((c) => c.osmRef === ref)!.score;
    expect(score("node:3")).toBeGreaterThan(score("node:1"));
  });

  it("asks Wikimedia once per place, then answers from the cache", async () => {
    const spots = [sight(1, 0.001, "Kapelle am Markt"), sight(3, 0.003, "Musterdom")];
    await fameFor(spots, CITY);
    const before = fake.calls;
    const again = await fameFor(spots, CITY);
    expect(fake.calls).toBe(before);
    expect(again.get("node:3")?.pageviews).toBe(25_000);
  });

  it("ranks the old way when Wikimedia is down, and fills in later", async () => {
    fake.broken = true;
    const spots = [sight(3, 0.003, "Musterdom")];
    expect((await fameFor(spots, CITY)).size).toBe(0);
    const [waiting] = await db.select().from(tripSpotFame);
    expect(waiting.fetched_at).toBeNull();

    fake.broken = false;
    expect(await refillSpotFame()).toBe(1);
    expect((await fameFor(spots, CITY)).get("node:3")?.wikivoyage).toBe("Gotischer Dom.");
  });
});

describe("a picture on the card", () => {
  it("takes the article's main image first, then Wikidata's, then one taken close by", async () => {
    const bare = { ...sight(4, 0.004, "Brunnen ohne Artikel"), wikidataQid: null, wikipedia: null };
    fake.near = [photo("File:Brunnen 2025.jpg")];
    await fameFor([sight(3, 0.003, "Musterdom"), sight(2, 0.002, "Rathaus Musterstadt"), bare], CITY);
    const images = await imagesFor(["node:3", "node:2", "node:4"]);
    expect(images.get("node:3")?.title).toBe("File:Musterdom Westfassade.jpg");
    expect(images.get("node:2")?.title).toBe("File:Rathaus von Norden.jpg");
    expect(images.get("node:4")?.title).toBe("File:Brunnen 2025.jpg");
    expect(images.get("node:4")?.license).toBe("CC BY-SA 4.0");
  });

  it("comes with every pool entry and stop of a loaded plan", async () => {
    const { plan } = await createTripPlan({ legs: [{ title: "Musterstadt", anchor: CITY, days: 1 }] });
    const { plan: loaded } = await getTripPlan({ planId: plan.id });
    const leg = loaded.legs[0];
    const all = [...leg.pool, ...leg.days.flatMap((d) => d.blocks.flatMap((b) => b.stops))];
    expect(all.find((s) => s.osmRef === "node:3")?.image?.title).toBe("File:Musterdom Westfassade.jpg");
  });

  it("puts the place's own picture first in the gallery, once", () => {
    const own = photo("File:Musterdom Westfassade.jpg");
    const gallery = galleryOf(own, [photo("File:Musterdom_Westfassade.jpg"), photo("File:Musterdom innen.jpg")]);
    expect(gallery.map((p) => p.title)).toEqual(["File:Musterdom Westfassade.jpg", "File:Musterdom innen.jpg"]);
  });
});

describe("articleOf", () => {
  it("reads the map's wikipedia tag", () => {
    expect(articleOf("it:Duomo di Esempio")).toEqual({ lang: "it", title: "Duomo di Esempio" });
    expect(articleOf("https://de.wikipedia.org/wiki/X")).toBeNull();
    expect(articleOf(null)).toBeNull();
  });
});
