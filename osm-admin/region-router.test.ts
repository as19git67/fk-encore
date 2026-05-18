import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import { InMemoryDockerDriver } from "./docker-driver";
import {
  clearRouterCache,
  ensureReady,
  geohash7,
  markUsed,
  pickRegion,
} from "./region-router";

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
});

describe("pickRegion", () => {
  it("returns null when no region covers the point", async () => {
    const m = await pickRegion(50, 11);
    expect(m).toBeNull();
  });

  it("returns the matching ready_running region with deterministic container hosts", async () => {
    await seed({ slug: "europe/germany/bayern", status: "ready_running" });
    const m = await pickRegion(48.137, 11.575);
    expect(m).not.toBeNull();
    expect(m!.slug).toBe("europe/germany/bayern");
    expect(m!.nominatimHost).toBe("nominatim-europe-germany-bayern");
    expect(m!.overpassHost).toBe("overpass-europe-germany-bayern");
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
    // Same geohash-7 cell so the cache key matches.
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

describe("ensureReady", () => {
  it("is a no-op for already-running regions", async () => {
    await seed({ slug: "europe/germany/bayern", status: "ready_running" });
    const driver = new InMemoryDockerDriver();
    await ensureReady("europe/germany/bayern", { driver });
    expect(driver.events).toEqual([]);
  });

  it("starts both containers and flips status from ready_stopped → ready_running", async () => {
    await seed({ slug: "europe/germany/bayern", status: "ready_stopped" });
    const driver = new InMemoryDockerDriver();
    await ensureReady("europe/germany/bayern", { driver });

    // Two ensureRunning calls (nominatim + overpass) followed by two
    // waitHealthy probes against their respective status URLs.
    expect(driver.events.map((e) => e.op)).toEqual([
      "ensureRunning",
      "ensureRunning",
      "waitHealthy",
      "waitHealthy",
    ]);
    const ensured = driver.events.filter((e) => e.op === "ensureRunning");
    expect(ensured.map((e) => e.name)).toEqual([
      "nominatim-europe-germany-bayern",
      "overpass-europe-germany-bayern",
    ]);

    const row = (
      await db
        .select()
        .from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.status).toBe("ready_running");
    expect(row.last_used_at).not.toBeNull();
  });

  it("throws when the cold-start healthcheck fails", async () => {
    await seed({ slug: "europe/germany/bayern", status: "ready_stopped" });
    const driver = new InMemoryDockerDriver();
    driver.healthyByDefault = false;
    await expect(
      ensureReady("europe/germany/bayern", { driver }),
    ).rejects.toThrow(/cold-start healthcheck failed/);

    // Status must stay ready_stopped — we do not "promote" a region
    // whose containers won't even answer their status URL.
    const row = (
      await db
        .select()
        .from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.status).toBe("ready_stopped");
  });

  it("refuses to start regions that aren't in a ready_* status", async () => {
    await seed({ slug: "europe/germany/bayern", status: "importing" });
    await expect(
      ensureReady("europe/germany/bayern", { driver: new InMemoryDockerDriver() }),
    ).rejects.toThrow(/cannot ensure ready/);
  });

  it("throws for an unknown slug", async () => {
    await expect(
      ensureReady("nope", { driver: new InMemoryDockerDriver() }),
    ).rejects.toThrow(/unknown region: nope/);
  });

  it("invalidates the router cache for the slug after a cold start", async () => {
    await seed({ slug: "europe/germany/bayern", status: "ready_stopped" });
    const before = await pickRegion(48.137, 11.575);
    expect(before!.status).toBe("ready_stopped");

    await ensureReady("europe/germany/bayern", { driver: new InMemoryDockerDriver() });
    const after = await pickRegion(48.137, 11.575);
    expect(after!.status).toBe("ready_running");
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

describe("OSM_ADMIN_NAME_PREFIX scopes router host names", () => {
  const original = process.env.OSM_ADMIN_NAME_PREFIX;
  afterEach(() => {
    if (original === undefined) delete process.env.OSM_ADMIN_NAME_PREFIX;
    else process.env.OSM_ADMIN_NAME_PREFIX = original;
  });

  it("pickRegion returns prefix-scoped Docker DNS hosts", async () => {
    process.env.OSM_ADMIN_NAME_PREFIX = "test-";
    await seed({ slug: "europe/germany/bayern", status: "ready_running" });
    const m = await pickRegion(48.137, 11.575);
    expect(m).not.toBeNull();
    expect(m!.nominatimHost).toBe("test-nominatim-europe-germany-bayern");
    expect(m!.overpassHost).toBe("test-overpass-europe-germany-bayern");
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
