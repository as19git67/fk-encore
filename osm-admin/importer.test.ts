import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import { InMemoryDockerDriver } from "./docker-driver";
import {
  nominatimDescriptor,
  overpassDescriptor,
  slugToContainerSuffix,
  tickImporter,
} from "./importer";

async function seedImporting(slug: string, geofabrikUrl = "https://example.com/x-latest.osm.pbf") {
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

  it("advances importing → ready_running when both containers are healthy", async () => {
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

    // Driver was asked to start exactly the two long-running containers
    // and to probe both healthchecks.
    expect(driver.events.map((e) => e.op)).toEqual([
      "ensureRunning",
      "ensureRunning",
      "waitHealthy",
      "waitHealthy",
    ]);
    const containerNames = driver.events
      .filter((e) => e.op === "ensureRunning")
      .map((e) => e.name);
    expect(containerNames).toEqual([
      "nominatim-europe-germany-bayern",
      "overpass-europe-germany-bayern",
    ]);
  });

  it("stays in `importing` and reports `waiting` when health is not yet up", async () => {
    await seedImporting("europe/germany/bayern");
    const driver = new InMemoryDockerDriver();
    driver.healthyByDefault = false;
    const out = await tickImporter({
      driver,
      probeSize: async () => 600,
      freeDiskMb: async () => 100_000,
    });
    expect(out.result).toBe("waiting");
    expect(out.detail).toContain("nominatim_healthy=false");
    expect(out.detail).toContain("overpass_healthy=false");

    const row = (
      await db
        .select()
        .from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.status).toBe("importing");
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

  it("transitions to failed on driver exception", async () => {
    await seedImporting("europe/germany/bayern");
    const driver = new InMemoryDockerDriver();
    driver.ensureRunning = async () => {
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
      geofabrik_url: "https://example.com/x-latest.osm.pbf",
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

  it("does not re-probe size on subsequent ticks once cached", async () => {
    await seedImporting("europe/germany/bayern");
    await db
      .update(osmRegionImports)
      .set({ pbf_size_mb: 600 })
      .where(eq(osmRegionImports.slug, "europe/germany/bayern"));
    let probeCalls = 0;
    await tickImporter({
      driver: new InMemoryDockerDriver(),
      probeSize: async () => {
        probeCalls++;
        return 600;
      },
      freeDiskMb: async () => 100_000,
    });
    expect(probeCalls).toBe(0);
  });
});

describe("descriptor builders", () => {
  it("nominatimDescriptor wires PBF_URL + named volume + replication URL", () => {
    const d = nominatimDescriptor(
      "europe/germany/bayern",
      "europe-germany-bayern",
      "https://download.geofabrik.de/europe/germany/bayern-latest.osm.pbf",
      "mediagis/nominatim:5.0",
    );
    expect(d.name).toBe("nominatim-europe-germany-bayern");
    expect(d.env?.PBF_URL).toMatch(/bayern-latest\.osm\.pbf$/);
    expect(d.env?.REPLICATION_URL).toBe(
      "https://download.geofabrik.de/europe/germany/bayern-updates/",
    );
    expect(d.volumes).toEqual([
      {
        hostPath: "fk-encore-osm-nominatim-europe-germany-bayern",
        containerPath: "/var/lib/postgresql/16/main",
      },
    ]);
  });

  it("overpassDescriptor wires PLANET_URL + preprocess + DIFF_URL + named volume", () => {
    const d = overpassDescriptor(
      "europe-germany-bayern",
      "https://download.geofabrik.de/europe/germany/bayern-latest.osm.pbf",
      "wiktorn/overpass-api:latest",
    );
    expect(d.env?.OVERPASS_PLANET_URL).toMatch(/bayern-latest\.osm\.pbf$/);
    // The Geofabrik download is PBF; default `bunzip2 -cd` would crash.
    // We override the preprocess to use osmconvert which auto-detects PBF.
    expect(d.env?.OVERPASS_PLANET_PREPROCESS).toBe("osmconvert -");
    expect(d.env?.OVERPASS_DIFF_URL).toBe(
      "https://download.geofabrik.de/europe/germany/bayern-updates/",
    );
    expect(d.volumes).toEqual([
      {
        hostPath: "fk-encore-osm-overpass-europe-germany-bayern",
        containerPath: "/db",
      },
    ]);
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
