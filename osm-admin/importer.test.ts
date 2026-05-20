import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports, photoScanQueue, photos, users } from "../db/schema";
import { InMemoryGeoClient } from "./geo-client.test-helper";
import { tickImporter } from "./importer";

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
      geo: new InMemoryGeoClient(),
      probeSize: async () => null,
    });
    expect(out).toEqual({ slug: null, result: "noop" });
  });

  it("kicks off the geo import on the first tick and reports waiting", async () => {
    await seedImporting("europe/germany/bayern");
    const geo = new InMemoryGeoClient();
    const out = await tickImporter({
      geo,
      probeSize: async () => 600,
      freeDiskMb: async () => 100_000,
    });
    expect(out.slug).toBe("europe/germany/bayern");
    expect(out.result).toBe("waiting");

    // The importer asked the geo service to start the work.
    expect(geo.getStartImportCalls()).toEqual([{
      slug: "europe/germany/bayern",
      postgresDb: "nom_europe_germany_bayern",
      pbfUrl: "https://example.com/x-latest.osm.pbf",
    }]);

    const row = (
      await db.select().from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.status).toBe("importing");
    expect(row.pbf_size_mb).toBe(600);
  });

  it("stays in `importing` and reports waiting while the geo state is running", async () => {
    await seedImporting("europe/germany/bayern");
    const geo = new InMemoryGeoClient();
    geo.setImportState("nom_europe_germany_bayern", "running");

    const out = await tickImporter({
      geo,
      probeSize: async () => 600,
      freeDiskMb: async () => 100_000,
    });
    expect(out.result).toBe("waiting");
    // No second startImport — the existing run is in progress.
    expect(geo.getStartImportCalls()).toEqual([]);

    const row = (
      await db.select().from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.status).toBe("importing");
  });

  it("advances importing → ready_running once the geo state is ready", async () => {
    await seedImporting("europe/germany/bayern");
    const geo = new InMemoryGeoClient();
    geo.setImportState("nom_europe_germany_bayern", "ready", {
      importedAt: "2026-05-16T12:00:00Z",
    });

    const out = await tickImporter({
      geo,
      probeSize: async () => 600,
      freeDiskMb: async () => 100_000,
    });
    expect(out.result).toBe("ready_running");

    const row = (
      await db.select().from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.status).toBe("ready_running");
    expect(row.imported_at).toBe("2026-05-16 12:00:00+00");
    expect(row.last_error).toBeNull();
  });

  it("transitions to failed when the geo state is failed", async () => {
    await seedImporting("europe/germany/bayern");
    const geo = new InMemoryGeoClient();
    geo.setImportState("nom_europe_germany_bayern", "failed", {
      error: "osm2pgsql exited with code 1",
    });

    const out = await tickImporter({
      geo,
      probeSize: async () => 600,
      freeDiskMb: async () => 100_000,
    });
    expect(out.result).toBe("failed");
    expect(out.detail).toContain("osm2pgsql exited");

    const row = (
      await db.select().from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("osm2pgsql exited");
  });

  it("transitions to blocked_disk when free space is below the threshold", async () => {
    await seedImporting("europe/germany/bayern");
    const geo = new InMemoryGeoClient();
    const out = await tickImporter({
      geo,
      probeSize: async () => 600,
      freeDiskMb: async () => 1_000, // way too little (need 6 000)
    });
    expect(out.result).toBe("blocked_disk");
    expect(out.detail).toContain("free=1000MB");
    expect(out.detail).toContain("need=6000MB");

    const row = (
      await db.select().from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.status).toBe("blocked_disk");
    // Critical: no geo work happened.
    expect(geo.getStartImportCalls()).toEqual([]);
  });

  it("transitions to failed when the geo client throws", async () => {
    await seedImporting("europe/germany/bayern");
    const geo = new InMemoryGeoClient();
    geo.startImport = async () => {
      throw new Error("geo socket gone");
    };
    const out = await tickImporter({
      geo,
      probeSize: async () => 600,
      freeDiskMb: async () => 100_000,
    });
    expect(out.result).toBe("failed");
    expect(out.detail).toContain("geo socket gone");
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
      geo: new InMemoryGeoClient(),
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
      geo: new InMemoryGeoClient(),
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
  function readyGeo(postgresDb: string): InMemoryGeoClient {
    const geo = new InMemoryGeoClient();
    geo.setImportState(postgresDb, "ready");
    return geo;
  }

  it("enqueues poi_detection for photos inside the new region's bbox when enabled", async () => {
    await seedImporting("europe/germany/bayern");
    const userId = await seedUser();
    const munichId = await seedPhotoAt(48.137, 11.575, 1, userId);
    await seedPhotoAt(52.5, 13.4, 2, userId);

    const out = await tickImporter({
      geo: readyGeo("nom_europe_germany_bayern"),
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
      geo: readyGeo("nom_europe_germany_bayern"),
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
    await db.insert(photoScanQueue).values({
      photo_id: munichId,
      user_id: null,
      service: "poi_detection",
      status: "done",
      priority: 3,
    });

    await tickImporter({
      geo: readyGeo("nom_europe_germany_bayern"),
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
      geo: readyGeo("nom_europe_germany_bayern"),
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
