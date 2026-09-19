/**
 * Importing a ready region again, because the style learned something.
 *
 * Two things carry the risk here and both are tested: that a region is
 * only ever picked because it *said* it lacks a table, and that the
 * database is dropped before the row moves — so a failed drop leaves a
 * working region working instead of stranding it in `importing`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import { InMemoryGeoClient } from "./geo-client.test-helper";
import { outdatedRegions, reimportOutdated } from "./reimport";

const ALL = ["osm_pois", "osm_highways", "osm_admin", "osm_routes"];
/** What an import from before the routes table produced. */
const WITHOUT_ROUTES = ["osm_pois", "osm_highways", "osm_admin"];

async function region(slug: string, status: string, postgresDb: string) {
  await db.insert(osmRegionImports).values({
    slug,
    geofabrik_url: `https://example.com/${postgresDb}.pbf`,
    postgres_db: postgresDb,
    bbox_min_lat: 47,
    bbox_min_lon: 9,
    bbox_max_lat: 50,
    bbox_max_lon: 13,
    status,
  });
}

let geo: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(osmRegionImports);
  geo = new InMemoryGeoClient();
});

describe("finding the regions an older style built", () => {
  it("lists a ready region that lacks a table, and says which", async () => {
    await region("europe/germany/bayern", "ready_running", "nom_bayern");
    geo.setRegionTables("nom_bayern", WITHOUT_ROUTES);

    const found = await outdatedRegions({ geo });

    expect(found.outdated).toHaveLength(1);
    expect(found.outdated[0].slug).toBe("europe/germany/bayern");
    expect(found.outdated[0].missing).toEqual(["osm_routes"]);
    expect(found.checked).toBe(1);
  });

  it("leaves a current region alone", async () => {
    await region("italy/nord-est", "ready_running", "nom_garda");
    geo.setRegionTables("nom_garda", ALL);

    const found = await outdatedRegions({ geo });

    expect(found.outdated).toEqual([]);
    expect(found.checked).toBe(1);
  });

  it("does not touch a region that is not ready", async () => {
    // Something being imported, blocked or failed has a state of its
    // own; dropping its database underneath the worker is a race.
    await region("a/importing", "importing", "nom_a");
    await region("b/failed", "failed", "nom_b");
    await region("c/pending", "pending_approval", "nom_c");
    for (const dbName of ["nom_a", "nom_b", "nom_c"]) {
      geo.setRegionTables(dbName, WITHOUT_ROUTES);
    }

    const found = await outdatedRegions({ geo });

    expect(found.outdated).toEqual([]);
    expect(found.checked).toBe(0);
  });

  it("takes a stopped region too — it is ready, just idle", async () => {
    await region("a/stopped", "ready_stopped", "nom_a");
    geo.setRegionTables("nom_a", WITHOUT_ROUTES);

    expect((await outdatedRegions({ geo })).outdated).toHaveLength(1);
  });

  it("says when it could not ask, rather than counting it as current", async () => {
    // "We could not tell" and "nothing missing" are different answers
    // (§15.3).
    await region("a/unreachable", "ready_running", "nom_a");
    geo.failTableProbe("nom_a");

    const found = await outdatedRegions({ geo });

    expect(found.outdated).toEqual([]);
    expect(found.unknown).toHaveLength(1);
    expect(found.unknown[0].slug).toBe("a/unreachable");
  });

  it("changes nothing at all", async () => {
    await region("europe/germany/bayern", "ready_running", "nom_bayern");
    geo.setRegionTables("nom_bayern", WITHOUT_ROUTES);

    await outdatedRegions({ geo });

    const rows = await db.select().from(osmRegionImports);
    expect(rows[0].status).toBe("ready_running");
    expect(geo.getDroppedRegions()).toEqual([]);
  });
});

describe("doing it", () => {
  it("drops the database and sets the row to import again", async () => {
    await region("europe/germany/bayern", "ready_running", "nom_bayern");
    geo.setRegionTables("nom_bayern", WITHOUT_ROUTES);

    const result = await reimportOutdated({ geo });

    expect(result.started).toHaveLength(1);
    expect(result.started[0]).toMatchObject({
      slug: "europe/germany/bayern",
      started: true,
      missing: ["osm_routes"],
    });
    expect(geo.getDroppedRegions()).toEqual(["nom_bayern"]);
    const rows = await db.select().from(osmRegionImports);
    expect(rows[0].status).toBe("importing");
  });

  it("leaves a current region ready, and counts it", async () => {
    await region("italy/nord-est", "ready_running", "nom_garda");
    geo.setRegionTables("nom_garda", ALL);

    const result = await reimportOutdated({ geo });

    expect(result.started).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(geo.getDroppedRegions()).toEqual([]);
    expect((await db.select().from(osmRegionImports))[0].status).toBe("ready_running");
  });

  it("keeps a region usable when the drop fails", async () => {
    // The order is the error handling: a row moved to `importing` with
    // its database still there would be a region nobody can use and
    // the importer would not replace.
    await region("europe/germany/bayern", "ready_running", "nom_bayern");
    geo.setRegionTables("nom_bayern", WITHOUT_ROUTES);
    geo.failDrop("nom_bayern");

    const result = await reimportOutdated({ geo });

    expect(result.started[0].started).toBe(false);
    expect(result.started[0].reason).toMatch(/nom_bayern/);
    expect((await db.select().from(osmRegionImports))[0].status).toBe("ready_running");
  });

  it("carries on past one region that fails", async () => {
    await region("a/broken", "ready_running", "nom_a");
    await region("b/fine", "ready_running", "nom_b");
    geo.setRegionTables("nom_a", WITHOUT_ROUTES);
    geo.setRegionTables("nom_b", WITHOUT_ROUTES);
    geo.failDrop("nom_a");

    const result = await reimportOutdated({ geo });

    expect(result.started).toHaveLength(2);
    expect(result.started.find((r) => r.slug === "b/fine")?.started).toBe(true);
    expect(geo.getDroppedRegions()).toEqual(["nom_b"]);
  });

  it("does nothing when every region is current", async () => {
    await region("italy/nord-est", "ready_running", "nom_garda");
    geo.setRegionTables("nom_garda", ALL);

    const result = await reimportOutdated({ geo });

    expect(result).toMatchObject({ started: [], skipped: 1, unknown: [] });
  });
});
