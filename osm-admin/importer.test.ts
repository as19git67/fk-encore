import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports, photoScanQueue, photos, users } from "../db/schema";
import { InMemoryDockerDriver } from "./docker-driver";
import {
  nominatimDescriptor,
  overpassDescriptor,
  overpassHealthcheckUrl,
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
  await db.delete(photoScanQueue);
  await db.delete(photos);
  await db.delete(users);
});

async function seedPhotoAt(lat: number, lon: number, idx: number, userId: number): Promise<number> {
  const [row] = await db
    .insert(photos)
    .values({
      user_id: userId,
      filename: `p${idx}.jpg`,
      original_name: `p${idx}.jpg`,
      mime_type: "image/jpeg",
      size: 1,
      latitude: lat,
      longitude: lon,
    })
    .returning({ id: photos.id });
  return row.id;
}

async function seedUser(): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({ email: `t${Date.now()}@x`, name: "T", password_hash: "x" })
    .returning({ id: users.id });
  return u.id;
}

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

describe("tickImporter — poi_detection backfill on ready_running", () => {
  it("enqueues poi_detection for photos inside the new region's bbox when enabled", async () => {
    await seedImporting("europe/germany/bayern");
    const userId = await seedUser();
    // Photo in Bayern (covered by bbox above)
    const munichId = await seedPhotoAt(48.137, 11.575, 1, userId);
    // Photo far outside — should not be enqueued
    await seedPhotoAt(52.5, 13.4, 2, userId);

    const out = await tickImporter({
      driver: new InMemoryDockerDriver(),
      probeSize: async () => 600,
      freeDiskMb: async () => 100_000,
      poiDetectionEnabled: true,
    });
    expect(out.result).toBe("ready_running");

    const queueRows = await db
      .select()
      .from(photoScanQueue)
      .where(eq(photoScanQueue.service, "poi_detection"));
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0].photo_id).toBe(munichId);
    expect(queueRows[0].status).toBe("pending");
  });

  it("skips the backfill entirely when disabled", async () => {
    await seedImporting("europe/germany/bayern");
    const userId = await seedUser();
    await seedPhotoAt(48.137, 11.575, 1, userId);

    await tickImporter({
      driver: new InMemoryDockerDriver(),
      probeSize: async () => 600,
      freeDiskMb: async () => 100_000,
      poiDetectionEnabled: false,
    });

    const queueRows = await db
      .select()
      .from(photoScanQueue)
      .where(eq(photoScanQueue.service, "poi_detection"));
    expect(queueRows).toEqual([]);
  });

  it("replaces existing `done` poi_detection rows for photos in the bbox", async () => {
    await seedImporting("europe/germany/bayern");
    const userId = await seedUser();
    const munichId = await seedPhotoAt(48.137, 11.575, 1, userId);
    // Simulate a previously-completed scan that produced no match
    // because the region wasn't imported yet.
    await db.insert(photoScanQueue).values({
      photo_id: munichId,
      user_id: null,
      service: "poi_detection",
      status: "done",
      priority: 3,
    });

    await tickImporter({
      driver: new InMemoryDockerDriver(),
      probeSize: async () => 600,
      freeDiskMb: async () => 100_000,
      poiDetectionEnabled: true,
    });

    const queueRows = await db
      .select()
      .from(photoScanQueue)
      .where(eq(photoScanQueue.service, "poi_detection"));
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0].status).toBe("pending");
  });

  it("does not duplicate when a pending row already exists", async () => {
    await seedImporting("europe/germany/bayern");
    const userId = await seedUser();
    const munichId = await seedPhotoAt(48.137, 11.575, 1, userId);
    await db.insert(photoScanQueue).values({
      photo_id: munichId,
      user_id: null,
      service: "poi_detection",
      status: "pending",
      priority: 3,
    });

    await tickImporter({
      driver: new InMemoryDockerDriver(),
      probeSize: async () => 600,
      freeDiskMb: async () => 100_000,
      poiDetectionEnabled: true,
    });

    const queueRows = await db
      .select()
      .from(photoScanQueue)
      .where(eq(photoScanQueue.service, "poi_detection"));
    expect(queueRows).toHaveLength(1);
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

  it("overpassDescriptor wires PBF URL + osmium-based preprocess + DIFF_URL + named volume", () => {
    const d = overpassDescriptor(
      "europe-germany-bayern",
      "https://download.geofabrik.de/europe/germany/bayern-latest.osm.pbf",
      "wiktorn/overpass-api:latest",
    );
    expect(d.env?.OVERPASS_PLANET_URL).toBe(
      "https://download.geofabrik.de/europe/germany/bayern-latest.osm.pbf",
    );
    // Preprocess uses osmium (bundled in the upstream image — see line
    // 95 of wiktorn's docker-entrypoint.sh) to convert PBF → bz2 OSM
    // XML in place. init_osm3s.sh then consumes /db/planet.osm.bz2
    // unchanged.
    expect(d.env?.OVERPASS_PLANET_PREPROCESS).toContain("osmium cat");
    expect(d.env?.OVERPASS_PLANET_PREPROCESS).toContain("-f osm.bz2");
    expect(d.env?.OVERPASS_PLANET_PREPROCESS).toContain("/db/planet.osm.bz2");
    expect(d.env?.OVERPASS_PLANET_PREPROCESS).toContain("/db/planet.input.pbf");
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

describe("overpassHealthcheckUrl", () => {
  it("hits /api/interpreter with a trivial out-count query", () => {
    const url = overpassHealthcheckUrl("europe-germany-bayern");
    // Critical: NOT /api/status — the wiktorn image's status reporter
    // throws std::out_of_range under load and returns 502, making the
    // container appear unhealthy when it's actually serving fine.
    expect(url).toBe(
      "http://overpass-europe-germany-bayern/api/interpreter" +
        "?data=%5Bout%3Ajson%5D%3Bout+count%3B",
    );
    // The encoded query decodes to "[out:json];out count;"
    const u = new URL(url);
    expect(u.searchParams.get("data")).toBe("[out:json];out count;");
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

describe("OSM_ADMIN_NAME_PREFIX flows through descriptor builders", () => {
  const original = process.env.OSM_ADMIN_NAME_PREFIX;
  afterEach(() => {
    if (original === undefined) delete process.env.OSM_ADMIN_NAME_PREFIX;
    else process.env.OSM_ADMIN_NAME_PREFIX = original;
  });

  it("scopes nominatim container and volume names", () => {
    process.env.OSM_ADMIN_NAME_PREFIX = "test-";
    const d = nominatimDescriptor(
      "europe/germany/bayern",
      "europe-germany-bayern",
      "https://example.com/x.pbf",
      "mediagis/nominatim:5.0",
    );
    expect(d.name).toBe("test-nominatim-europe-germany-bayern");
    expect(d.volumes?.[0].hostPath).toBe(
      "test-fk-encore-osm-nominatim-europe-germany-bayern",
    );
  });

  it("scopes overpass container, volume, and the healthcheck URL", () => {
    process.env.OSM_ADMIN_NAME_PREFIX = "test-";
    const d = overpassDescriptor(
      "europe-germany-bayern",
      "https://example.com/x.pbf",
      "wiktorn/overpass-api:latest",
    );
    expect(d.name).toBe("test-overpass-europe-germany-bayern");
    expect(d.volumes?.[0].hostPath).toBe(
      "test-fk-encore-osm-overpass-europe-germany-bayern",
    );
    expect(overpassHealthcheckUrl("europe-germany-bayern")).toBe(
      "http://test-overpass-europe-germany-bayern/api/interpreter" +
        "?data=%5Bout%3Ajson%5D%3Bout+count%3B",
    );
  });
});
