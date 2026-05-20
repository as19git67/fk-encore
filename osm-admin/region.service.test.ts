import { beforeEach, describe, expect, it } from "vitest";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import {
  approve,
  createPending,
  remove,
  slugToPostgresDb,
  suggestForCoord,
} from "./region.service";
import { InMemoryGeoClient } from "./geo-client.test-helper";
import { parseIndex, type GeofabrikIndex } from "./geofabrik-index";

function fixture(): GeofabrikIndex {
  const raw = JSON.stringify({
    features: [
      {
        properties: {
          id: "europe",
          name: "Europe",
          urls: { pbf: "https://example.com/europe.osm.pbf" },
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-10, 35],
              [40, 35],
              [40, 70],
              [-10, 70],
              [-10, 35],
            ],
          ],
        },
      },
      {
        properties: {
          id: "europe/germany",
          name: "Germany",
          parent: "europe",
          urls: { pbf: "https://example.com/germany.osm.pbf" },
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [6, 47],
              [15, 47],
              [15, 55],
              [6, 55],
              [6, 47],
            ],
          ],
        },
      },
      {
        properties: {
          id: "europe/germany/bayern",
          name: "Bayern",
          parent: "europe/germany",
          urls: { pbf: "https://example.com/bayern.osm.pbf" },
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [9, 47.5],
              [13.5, 47.5],
              [13.5, 50.5],
              [9, 50.5],
              [9, 47.5],
            ],
          ],
        },
      },
    ],
  });
  return parseIndex(raw, new Date("2026-01-01T00:00:00Z"));
}

const loadIndex = async () => fixture();

beforeEach(async () => {
  await db.delete(osmRegionImports);
});

describe("suggestForCoord", () => {
  it("returns the smallest covering region with default-not-existing", async () => {
    const s = await suggestForCoord(48.137, 11.575, { loadIndex });
    expect(s).not.toBeNull();
    expect(s!.slug).toBe("europe/germany/bayern");
    expect(s!.existing).toBe(false);
    expect(s!.existingStatus).toBeNull();
    expect(s!.bbox).toEqual({ minLon: 9, minLat: 47.5, maxLon: 13.5, maxLat: 50.5 });
  });

  it("reports an existing region's persisted status", async () => {
    await createPending("europe/germany/bayern", { loadIndex });
    const s = await suggestForCoord(48.137, 11.575, { loadIndex });
    expect(s!.existing).toBe(true);
    expect(s!.existingStatus).toBe("pending_approval");
  });

  it("returns null when the point is outside every region", async () => {
    const s = await suggestForCoord(25, -30, { loadIndex });
    expect(s).toBeNull();
  });
});

describe("createPending", () => {
  it("inserts a new row in pending_approval", async () => {
    const r = await createPending("europe/germany/bayern", { loadIndex });
    expect(r).toEqual({
      slug: "europe/germany/bayern",
      status: "pending_approval",
      created: true,
    });

    const rows = await db.select().from(osmRegionImports);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe("europe/germany/bayern");
    expect(rows[0].postgres_db).toBe("nom_europe_germany_bayern");
    expect(rows[0].geofabrik_url).toBe("https://example.com/bayern.osm.pbf");
    expect(rows[0].bbox_min_lat).toBe(47.5);
  });

  it("is idempotent — second call leaves the status unchanged", async () => {
    await createPending("europe/germany/bayern", { loadIndex });
    await approve("europe/germany/bayern");
    const second = await createPending("europe/germany/bayern", { loadIndex });
    expect(second).toEqual({
      slug: "europe/germany/bayern",
      status: "importing",
      created: false,
    });
  });

  it("rejects an unknown slug", async () => {
    await expect(
      createPending("unknown/region", { loadIndex }),
    ).rejects.toThrow(/unknown Geofabrik region: unknown\/region/);
  });
});

describe("approve", () => {
  it("flips pending_approval → importing", async () => {
    await createPending("europe/germany/bayern", { loadIndex });
    const s = await approve("europe/germany/bayern");
    expect(s).toBe("importing");

    const rows = await db.select().from(osmRegionImports);
    expect(rows[0].status).toBe("importing");
  });

  it("is idempotent for already-importing rows", async () => {
    await createPending("europe/germany/bayern", { loadIndex });
    await approve("europe/germany/bayern");
    const s = await approve("europe/germany/bayern");
    expect(s).toBe("importing");
  });

  it("throws on illegal transitions", async () => {
    await createPending("europe/germany/bayern", { loadIndex });
    await db
      .update(osmRegionImports)
      .set({ status: "ready_running" });
    await expect(approve("europe/germany/bayern")).rejects.toThrow(
      /invalid region status transition: ready_running → importing/,
    );
  });

  it("throws for an unknown slug", async () => {
    await expect(approve("not/there")).rejects.toThrow(/unknown region: not\/there/);
  });
});

describe("remove", () => {
  it("deletes an existing row and asks the geo service to drop the postgres DB", async () => {
    await createPending("europe/germany/bayern", { loadIndex });
    const geo = new InMemoryGeoClient();
    const deleted = await remove("europe/germany/bayern", { geo });
    expect(deleted).toBe(true);

    const rows = await db.select().from(osmRegionImports);
    expect(rows).toEqual([]);
    expect(geo.getDroppedRegions()).toEqual(["nom_europe_germany_bayern"]);
  });

  it("returns false without calling geo when the row doesn't exist", async () => {
    const geo = new InMemoryGeoClient();
    const deleted = await remove("nothing/here", { geo });
    expect(deleted).toBe(false);
    expect(geo.getDroppedRegions()).toEqual([]);
  });

  it("still drops the DB row when the geo drop fails (best-effort cleanup)", async () => {
    await createPending("europe/germany/bayern", { loadIndex });
    const geo = new InMemoryGeoClient();
    geo.dropRegion = async () => {
      throw new Error("geo down");
    };
    const deleted = await remove("europe/germany/bayern", { geo });
    expect(deleted).toBe(true);
    const rows = await db.select().from(osmRegionImports);
    expect(rows).toEqual([]);
  });
});

describe("slugToPostgresDb", () => {
  it("sanitises slashes and casing", () => {
    expect(slugToPostgresDb("Europe/Germany/Bayern")).toBe(
      "nom_europe_germany_bayern",
    );
  });

  it("collapses repeated separators and trims trailing underscores", () => {
    expect(slugToPostgresDb("a/-/b")).toBe("nom_a_b");
  });
});
