import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import {
  clearRouterCache,
  geohash7,
  markUsed,
  pickRegion,
  setRegionIndexSource,
} from "./region-router";
import { resetGeoClient, setGeoClient } from "./geo-client";
import { InMemoryGeoClient } from "./geo-client.test-helper";

async function seed(opts: {
  slug: string;
  status?: "ready_running" | "ready_stopped" | "importing" | "pending_approval";
  bbox?: [number, number, number, number]; // [minLat, minLon, maxLat, maxLon]
}) {
  const bbox = opts.bbox ?? [47.5, 9, 50.5, 13.5];
  await db.insert(osmRegionImports).values({
    slug: opts.slug,
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: "nom_" + opts.slug.replace(/[^a-z0-9]/g, "_"),
    bbox_min_lat: bbox[0],
    bbox_min_lon: bbox[1],
    bbox_max_lat: bbox[2],
    bbox_max_lon: bbox[3],
    status: opts.status ?? "ready_running",
  });
}

beforeEach(async () => {
  await db.delete(osmRegionImports);
  clearRouterCache();
  // The default probe asks the geo service whether the database really
  // holds that corner of the world. Left unset it would answer "yes" to
  // everything, which is the fiction these tests are about.
  setGeoClient(new InMemoryGeoClient());
  // No opinion on which extract contains the point unless a test says
  // so — the polygon is its own subject below.
  setRegionIndexSource(null);
  return () => resetGeoClient();
});

describe("pickRegion", () => {
  it("returns null when no region covers the point", async () => {
    const m = await pickRegion(50, 11);
    expect(m).toBeNull();
  });

  it("returns the matching ready_running region with its postgres database name", async () => {
    await seed({ slug: "europe/germany/bayern", status: "ready_running" });
    const m = await pickRegion(48.137, 11.575);
    expect(m).not.toBeNull();
    expect(m!.slug).toBe("europe/germany/bayern");
    expect(m!.postgresDb).toBe("nom_europe_germany_bayern");
  });

  it("ignores regions that are not in a ready_* status", async () => {
    await seed({ slug: "europe/germany/bayern", status: "importing" });
    const m = await pickRegion(48.137, 11.575);
    expect(m).toBeNull();
  });

  it("picks the smallest bbox when multiple regions cover the point", async () => {
    // Big Europe-shaped box + tiny Bayern-shaped box both contain Munich.
    await seed({
      slug: "europe",
      status: "ready_running",
      bbox: [35, -10, 70, 40],
    });
    await seed({
      slug: "europe/germany/bayern",
      status: "ready_running",
      bbox: [47.5, 9, 50.5, 13.5],
    });
    const m = await pickRegion(48.137, 11.575);
    expect(m!.slug).toBe("europe/germany/bayern");
  });

  it("includes ready_stopped regions in the candidate set", async () => {
    // ready_stopped is a leftover status from the docker-driven era;
    // the geo service treats it the same as ready_running.
    await seed({ slug: "europe/germany/bayern", status: "ready_stopped" });
    const m = await pickRegion(48.137, 11.575);
    expect(m).not.toBeNull();
    expect(m!.status).toBe("ready_stopped");
  });

  it("caches null hits keyed on geohash so repeated misses are cheap", async () => {
    const m1 = await pickRegion(48.137, 11.575);
    expect(m1).toBeNull();
    // Insert AFTER the first lookup — the cached null should still win.
    await seed({ slug: "europe/germany/bayern", status: "ready_running" });
    const m2 = await pickRegion(48.137, 11.575);
    expect(m2).toBeNull();
  });

  it("does not let a stale cache entry leak across regions", async () => {
    await seed({ slug: "europe/germany/bayern", status: "ready_running" });
    const m1 = await pickRegion(48.137, 11.575);
    expect(m1!.slug).toBe("europe/germany/bayern");
    // A point far away must miss the cache and hit the DB cleanly.
    const m2 = await pickRegion(35.5, -2);
    expect(m2).toBeNull();
  });
});

describe("pickRegion and the extract's border", () => {
  /**
   * A lake as the border. One region imported, on the west shore; its
   * rectangle reaches across the water, and so does the 25 km data
   * probe — the far shore is five kilometres away. Only the polygon
   * knows which side is which.
   */
  const WEST_SHORE = { lat: 45.8, lon: 10.70 };
  const EAST_SHORE = { lat: 45.8, lon: 10.90 };

  function lakeIndex() {
    setRegionIndexSource({
      containing: async (_lat, lon) =>
        lon < 10.8 ? ["europe", "europe/italy", "europe/italy/nord-ovest"]
                   : ["europe", "europe/italy", "europe/italy/nord-est"],
    });
  }

  it("rejects a region whose rectangle contains the point but whose extract does not", async () => {
    // The reported case: four days on the east shore were planned out
    // of the west shore's database, a hundred spots on the wrong side
    // of the water, because the bbox and the probe both said yes.
    await seed({ slug: "europe/italy/nord-ovest", bbox: [45.0, 7.0, 46.7, 11.5] });
    lakeIndex();

    expect(await pickRegion(EAST_SHORE.lat, EAST_SHORE.lon)).toBeNull();
  });

  it("keeps the region whose extract contains the point", async () => {
    await seed({ slug: "europe/italy/nord-ovest", bbox: [45.0, 7.0, 46.7, 11.5] });
    lakeIndex();

    expect((await pickRegion(WEST_SHORE.lat, WEST_SHORE.lon))?.slug)
      .toBe("europe/italy/nord-ovest");
  });

  it("picks the far shore's own region once it is imported", async () => {
    // Both shores imported, both rectangles reaching across: the
    // polygon sends each point home, and the smaller-bbox rule never
    // gets to choose between two wrong answers.
    await seed({ slug: "europe/italy/nord-ovest", bbox: [45.0, 7.0, 46.7, 11.5] });
    await seed({ slug: "europe/italy/nord-est", bbox: [44.0, 10.3, 47.1, 13.9] });
    lakeIndex();

    expect((await pickRegion(EAST_SHORE.lat, EAST_SHORE.lon))?.slug)
      .toBe("europe/italy/nord-est");
    expect((await pickRegion(WEST_SHORE.lat, WEST_SHORE.lon))?.slug)
      .toBe("europe/italy/nord-ovest");
  });

  it("accepts an enclosing extract as well as the exact one", async () => {
    // Extracts nest. A point in Bayern is also in Germany and in
    // Europe, and whichever of those is imported holds it.
    await seed({ slug: "europe/germany", bbox: [47, 5, 55, 16] });
    setRegionIndexSource({
      containing: async () => ["europe", "europe/germany", "europe/germany/bayern"],
    });

    expect((await pickRegion(48.137, 11.575))?.slug).toBe("europe/germany");
  });

  it("leaves the decision to the probe when the index has no opinion", async () => {
    // No cache, no network: the polygon abstains rather than refusing
    // every region and turning an outage into a queue of imports.
    await seed({ slug: "europe/italy/nord-ovest", bbox: [45.0, 7.0, 46.7, 11.5] });
    setRegionIndexSource(null);

    expect((await pickRegion(EAST_SHORE.lat, EAST_SHORE.lon))?.slug)
      .toBe("europe/italy/nord-ovest");
  });

  it("treats a failing index the same as an absent one", async () => {
    await seed({ slug: "europe/italy/nord-ovest", bbox: [45.0, 7.0, 46.7, 11.5] });
    setRegionIndexSource({
      containing: async () => { throw new Error("index-v1.json: ECONNRESET"); },
    });

    expect((await pickRegion(EAST_SHORE.lat, EAST_SHORE.lon))?.slug)
      .toBe("europe/italy/nord-ovest");
  });

  it("still asks the data once the border agrees", async () => {
    // The probe keeps its one job: an extract that contains the point
    // but whose import came back empty.
    await seed({ slug: "europe/italy/nord-ovest", bbox: [45.0, 7.0, 46.7, 11.5] });
    lakeIndex();
    const geo = new InMemoryGeoClient();
    geo.setCoverage("nom_europe_italy_nord_ovest", { lat: 44.0, lon: 8.0 }, 10_000);
    setGeoClient(geo);

    expect(await pickRegion(WEST_SHORE.lat, WEST_SHORE.lon)).toBeNull();
  });
});

describe("markUsed", () => {
  it("updates last_used_at to the current time", async () => {
    await seed({ slug: "europe/germany/bayern", status: "ready_running" });
    const fixed = new Date("2026-05-16T12:00:00Z");
    await markUsed("europe/germany/bayern", { now: () => fixed });
    const row = (
      await db
        .select()
        .from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.last_used_at).toBe("2026-05-16 12:00:00+00");
  });
});

describe("geohash7", () => {
  it("produces 7-char base-32 strings", () => {
    const h = geohash7(48.137, 11.575, 7);
    expect(h).toHaveLength(7);
    expect(h).toMatch(/^[0-9bcdefghjkmnpqrstuvwxyz]+$/);
  });

  it("returns the same hash for points within the same ~150 m cell", () => {
    const a = geohash7(48.137, 11.575, 7);
    const b = geohash7(48.1371, 11.5751, 7); // ~10 m apart
    expect(a).toBe(b);
  });

  it("returns different hashes for far-apart points", () => {
    const a = geohash7(48.137, 11.575, 7); // Munich
    const b = geohash7(53.55, 10.0, 7); // Hamburg
    expect(a).not.toBe(b);
  });
});

describe("a bounding box that lies", () => {
  /**
   * Italy's Nord-Ovest — Piedmont, Liguria, Lombardy — in a rectangle
   * that reaches south past Pisa and east past Florence. Its data stops
   * at the Tuscan border, and for a while the planner did not know
   * that: a trip to Pisa came back with no spots and no explanation.
   */
  const PISA = { lat: 43.7199, lon: 10.3973 };
  const TURIN = { lat: 45.0703, lon: 7.6869 };

  async function seedNordOvest() {
    await seed({ slug: "italy/nord-ovest", bbox: [43.7, 6.6, 46.6, 11.4] });
  }

  it("refuses a region whose data does not reach the point", async () => {
    const geo = new InMemoryGeoClient();
    geo.setCoverage("nom_italy_nord_ovest", TURIN);
    setGeoClient(geo);
    await seedNordOvest();

    // The rectangle contains Pisa; the extract does not. Null is the
    // honest answer, and it is what makes the caller ask for the right
    // region instead of planning an empty trip.
    expect(await pickRegion(PISA.lat, PISA.lon)).toBeNull();
  });

  it("still returns the region for a point it really holds", async () => {
    const geo = new InMemoryGeoClient();
    geo.setCoverage("nom_italy_nord_ovest", TURIN);
    setGeoClient(geo);
    await seedNordOvest();

    expect((await pickRegion(TURIN.lat, TURIN.lon))?.slug).toBe("italy/nord-ovest");
  });

  it("moves on to the next rectangle when the smallest one is wrong", async () => {
    const geo = new InMemoryGeoClient();
    geo.setCoverage("nom_italy_centro", PISA);
    setGeoClient(geo);
    await seedNordOvest();
    await seed({ slug: "italy/centro", bbox: [41.0, 9.0, 44.5, 14.0] });

    // Nord-Ovest has the smaller rectangle and would have won on area
    // alone. The data decides instead.
    expect((await pickRegion(PISA.lat, PISA.lon))?.slug).toBe("italy/centro");
  });

  it("keeps the bbox match when the probe itself fails", async () => {
    // An unreachable geo service is a fault of its own. Turning it into
    // "this region does not cover Pisa" would send a good trip off to
    // import a region it already has.
    const geo = new InMemoryGeoClient();
    geo.setHealthy(false);
    setGeoClient({
      ...geo,
      hasCoverage: async () => { throw new Error("geo: connect ECONNREFUSED"); },
    } as unknown as InMemoryGeoClient);
    await seedNordOvest();

    expect((await pickRegion(PISA.lat, PISA.lon))?.slug).toBe("italy/nord-ovest");
  });
});
