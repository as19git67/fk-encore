import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import { InMemoryDockerDriver } from "./docker-driver";
import { slugToContainerSuffix, tickImporter } from "./importer";

async function seedImporting(slug: string, geofabrikUrl = "https://example.com/x.pbf") {
  await db.insert(osmRegionImports).values({
    slug,
    geofabrik_url: geofabrikUrl,
    postgres_db: `nom_${slug.replace(/[^a-z0-9]/g, "_")}`,
    bbox_min_lat: 47.5,
    bbox_min_lon: 9,
    bbox_max_lat: 50.5,
    bbox_max_lon: 13.5,
    status: "importing",
    // Place updated_at well before the cooldown so the row is pickable.
    updated_at: new Date(Date.now() - 60_000).toISOString(),
  });
}

beforeEach(async () => {
  await db.delete(osmRegionImports);
});

describe("tickImporter", () => {
  it("is a no-op when no rows are importing", async () => {
    const out = await tickImporter({
      driver: new InMemoryDockerDriver(),
      probeSize: async () => null,
    });
    expect(out).toEqual({ slug: null, result: "noop" });
  });

  it("advances importing → ready_running on the happy path", async () => {
    await seedImporting("europe/germany/bayern");
    const driver = new InMemoryDockerDriver();
    const out = await tickImporter({
      driver,
      probeSize: async () => 600,
      freeDiskMb: async () => 100_000,
    });
    expect(out.slug).toBe("europe/germany/bayern");
    expect(out.result).toBe("ready_running");

    const row = (
      await db
        .select()
        .from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.status).toBe("ready_running");
    expect(row.pbf_size_mb).toBe(600);
    expect(row.imported_at).not.toBeNull();
    expect(row.last_error).toBeNull();

    // Driver received the one-shot then the two persistent containers.
    expect(driver.events.map((e) => e.op)).toEqual([
      "runOneShot",
      "ensureRunning",
      "ensureRunning",
    ]);
    expect(driver.events.map((e) => e.name)).toEqual([
      "nominatim-import-europe-germany-bayern",
      "nominatim-europe-germany-bayern",
      "overpass-europe-germany-bayern",
    ]);
  });

  it("transitions to blocked_disk when free space is below the threshold", async () => {
    await seedImporting("europe/germany/bayern");
    const driver = new InMemoryDockerDriver();
    const out = await tickImporter({
      driver,
      probeSize: async () => 600,
      freeDiskMb: async () => 1_000, // way too little (need 6 000)
    });
    expect(out.result).toBe("blocked_disk");
    expect(out.detail).toContain("free=1000MB");
    expect(out.detail).toContain("need=6000MB");

    const row = (
      await db
        .select()
        .from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.status).toBe("blocked_disk");
    // Critical: no docker work happened.
    expect(driver.events).toEqual([]);
  });

  it("transitions to failed on driver one-shot non-zero exit", async () => {
    await seedImporting("europe/germany/bayern");
    const driver = new InMemoryDockerDriver();
    driver.oneShotExitCode = 137;
    const out = await tickImporter({
      driver,
      probeSize: async () => 600,
      freeDiskMb: async () => 100_000,
    });
    expect(out.result).toBe("failed");
    expect(out.detail).toContain("exit=137");

    const row = (
      await db
        .select()
        .from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("exit=137");
    // No persistent containers were started after the failed one-shot.
    expect(driver.events.map((e) => e.op)).toEqual(["runOneShot"]);
  });

  it("transitions to failed on driver exception", async () => {
    await seedImporting("europe/germany/bayern");
    const driver = new InMemoryDockerDriver();
    driver.runOneShot = async () => {
      throw new Error("docker socket gone");
    };
    const out = await tickImporter({
      driver,
      probeSize: async () => 600,
      freeDiskMb: async () => 100_000,
    });
    expect(out.result).toBe("failed");
    expect(out.detail).toContain("docker socket gone");
  });

  it("does not re-pick a row within the cooldown window", async () => {
    await db.insert(osmRegionImports).values({
      slug: "europe/germany/bayern",
      geofabrik_url: "https://example.com/x.pbf",
      postgres_db: "nom_bayern",
      bbox_min_lat: 47.5,
      bbox_min_lon: 9,
      bbox_max_lat: 50.5,
      bbox_max_lon: 13.5,
      status: "importing",
      updated_at: new Date().toISOString(), // very recent
    });
    const out = await tickImporter({
      driver: new InMemoryDockerDriver(),
      probeSize: async () => null,
    });
    expect(out).toEqual({ slug: null, result: "noop" });
  });
});

describe("slugToContainerSuffix", () => {
  it("flattens slashes and lowercases", () => {
    expect(slugToContainerSuffix("europe/germany/bayern")).toBe(
      "europe-germany-bayern",
    );
  });

  it("collapses repeated separators and trims edges", () => {
    expect(slugToContainerSuffix("/a//b/")).toBe("a-b");
  });
});
