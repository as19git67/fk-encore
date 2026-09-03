/**
 * The storage endpoint's own logic: look the region up, ask geo, and
 * turn "there is no database yet" into a state rather than a fault.
 *
 * The numbers themselves are geo's business and are tested there
 * against a real PostGIS instance; here only the wiring is at stake, so
 * the client is the in-memory one.
 */

import { beforeEach, describe, expect, it } from "vitest";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import { InMemoryGeoClient } from "./geo-client.test-helper";
import { type GeoRegionStorage } from "./geo-client";
import { regionStorage } from "./region.service";

const STORAGE: GeoRegionStorage = {
  database: "nom_schwaben",
  sizeMb: 1234.5,
  tables: [
    { table: "osm_pois", totalMb: 40.5, tableMb: 22.25, rows: 51_000 },
    { table: "planet_osm_nodes", totalMb: 900, tableMb: 880, rows: 9_000_000 },
  ],
  poisByKind: [
    { kind: "amenity=cafe", count: 3_100 },
    { kind: "tourism=museum", count: 210 },
  ],
  poiTotal: 51_000,
  poisWithShape: 12_000,
  poisWithFacadeAzimuth: 12_000,
};

async function seedRegion(slug: string, postgresDb: string): Promise<void> {
  await db.insert(osmRegionImports).values({
    slug,
    geofabrik_url: `https://download.geofabrik.de/${slug}-latest.osm.pbf`,
    postgres_db: postgresDb,
    status: "ready_running",
    bbox_min_lat: 47.9,
    bbox_min_lon: 9.9,
    bbox_max_lat: 48.9,
    bbox_max_lon: 11.1,
  });
}

let client: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(osmRegionImports);
  client = new InMemoryGeoClient();
});

describe("region storage", () => {
  it("passes geo's breakdown through with the slug attached", async () => {
    await seedRegion("bayern-schwaben", "nom_schwaben");
    client.setRegionStorage("nom_schwaben", STORAGE);

    const res = await regionStorage("bayern-schwaben", { geo: client });

    expect(res.slug).toBe("bayern-schwaben");
    expect(res.sizeMb).toBe(1234.5);
    expect(res.poisByKind[0]).toEqual({ kind: "amenity=cafe", count: 3_100 });
    // The distinction the measurement turns on must survive the hop.
    const pois = res.tables.find((t) => t.table === "osm_pois");
    expect(pois?.totalMb).toBe(40.5);
    expect(pois?.tableMb).toBe(22.25);
  });

  it("reports an unknown region as not found", async () => {
    await expect(regionStorage("nirgendwo", { geo: client })).rejects.toThrow(/no region/);
  });

  it("treats a region without a database as a state, not a fault", async () => {
    await seedRegion("bayern-oberbayern", "nom_oberbayern");
    // No storage registered: the client rejects, as geo would for a
    // database that does not exist yet.
    await expect(regionStorage("bayern-oberbayern", { geo: client })).rejects.toThrow(
      /no storage figures/,
    );
  });
});
