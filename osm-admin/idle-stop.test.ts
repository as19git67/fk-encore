import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import { InMemoryDockerDriver } from "./docker-driver";
import { tickIdleStop } from "./idle-stop";

async function seedRegion(opts: {
  slug: string;
  status?: "ready_running" | "ready_stopped" | "importing";
  lastUsedAt?: string | null;
  updatedAt?: string;
}) {
  await db.insert(osmRegionImports).values({
    slug: opts.slug,
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: `nom_${opts.slug.replace(/[^a-z0-9]/g, "_")}`,
    bbox_min_lat: 47.5,
    bbox_min_lon: 9,
    bbox_max_lat: 50.5,
    bbox_max_lon: 13.5,
    status: opts.status ?? "ready_running",
    last_used_at: opts.lastUsedAt ?? null,
    updated_at: opts.updatedAt ?? new Date().toISOString(),
  });
}

beforeEach(async () => {
  await db.delete(osmRegionImports);
});

describe("tickIdleStop", () => {
  it("is a no-op when nothing is ready_running", async () => {
    await seedRegion({ slug: "europe/germany/bayern", status: "ready_stopped" });
    const driver = new InMemoryDockerDriver();
    const r = await tickIdleStop({ driver, idleStopMinutes: 30 });
    expect(r).toEqual({ stopped: [], failed: [] });
    expect(driver.events).toEqual([]);
  });

  it("leaves fresh regions running", async () => {
    // Region used 5 minutes ago — well within the 30 min window.
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    await seedRegion({ slug: "europe/germany/bayern", lastUsedAt: fiveMinAgo });
    const driver = new InMemoryDockerDriver();
    const r = await tickIdleStop({ driver, idleStopMinutes: 30 });
    expect(r.stopped).toEqual([]);
    expect(driver.events).toEqual([]);
  });

  it("stops both containers and flips status when idle past the threshold", async () => {
    // Region last used 45 minutes ago.
    const stale = new Date(Date.now() - 45 * 60_000).toISOString();
    await seedRegion({ slug: "europe/germany/bayern", lastUsedAt: stale });
    const driver = new InMemoryDockerDriver();
    const r = await tickIdleStop({ driver, idleStopMinutes: 30 });
    expect(r.stopped).toEqual(["europe/germany/bayern"]);

    expect(driver.events.map((e) => `${e.op}:${e.name}`)).toEqual([
      "stop:nominatim-europe-germany-bayern",
      "stop:overpass-europe-germany-bayern",
    ]);

    const row = (
      await db
        .select()
        .from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.status).toBe("ready_stopped");
  });

  it("falls back to updated_at when last_used_at is null", async () => {
    // Freshly imported region (never queried) whose import finished
    // 45 minutes ago — should be stopped just like a stale used one.
    const stale = new Date(Date.now() - 45 * 60_000).toISOString();
    await seedRegion({
      slug: "europe/germany/bayern",
      lastUsedAt: null,
      updatedAt: stale,
    });
    const driver = new InMemoryDockerDriver();
    const r = await tickIdleStop({ driver, idleStopMinutes: 30 });
    expect(r.stopped).toEqual(["europe/germany/bayern"]);
  });

  it("logs driver failures and keeps the row in ready_running", async () => {
    const stale = new Date(Date.now() - 45 * 60_000).toISOString();
    await seedRegion({ slug: "europe/germany/bayern", lastUsedAt: stale });
    const driver = new InMemoryDockerDriver();
    driver.stop = async () => {
      throw new Error("docker socket gone");
    };
    const r = await tickIdleStop({ driver, idleStopMinutes: 30 });
    expect(r.stopped).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].error).toContain("docker socket gone");

    const row = (
      await db
        .select()
        .from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.status).toBe("ready_running");
  });

  it("processes multiple stale regions in one tick", async () => {
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    await seedRegion({ slug: "europe/germany/bayern", lastUsedAt: stale });
    await seedRegion({ slug: "europe/france/ile-de-france", lastUsedAt: stale });
    const driver = new InMemoryDockerDriver();
    const r = await tickIdleStop({ driver, idleStopMinutes: 30 });
    expect(new Set(r.stopped)).toEqual(
      new Set(["europe/germany/bayern", "europe/france/ile-de-france"]),
    );
    expect(driver.events.length).toBe(4); // 2 stops × 2 regions
  });
});
