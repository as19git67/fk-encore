import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import { InMemoryGeoClient } from "./geo-client.test-helper";
import { refreshRegion } from "./refresh";

async function seedRegion(opts: {
  slug: string;
  status?: "ready_running" | "ready_stopped" | "importing";
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
  });
}

beforeEach(async () => {
  await db.delete(osmRegionImports);
});

describe("refreshRegion", () => {
  it("calls geo.refresh for a ready_running region and persists the new sequence", async () => {
    await seedRegion({ slug: "europe/germany/bayern" });
    const geo = new InMemoryGeoClient();
    geo.setRefreshResult("nom_europe_germany_bayern", {
      postgresDb: "nom_europe_germany_bayern",
      appliedDiffs: 7,
      sequence: 4775,
      timestamp: "2026-05-16T11:00:00Z",
    });
    const fixed = new Date("2026-05-16T12:00:00Z");

    const r = await refreshRegion("europe/germany/bayern", { geo, now: () => fixed });
    expect(r.ok).toBe(true);
    expect(r.replicationSeq).toBe("4775");
    expect(r.detail).toContain("applied 7");
    expect(geo.getRefreshCalls()).toEqual(["nom_europe_germany_bayern"]);

    const row = (
      await db.select().from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.replication_seq).toBe("4775");
    expect(row.last_error).toBeNull();
    expect(row.last_used_at).toBe("2026-05-16 12:00:00+00");
  });

  it("returns ok=true with the existing seq when geo reports no diffs", async () => {
    await seedRegion({ slug: "europe/germany/bayern" });
    await db
      .update(osmRegionImports)
      .set({ replication_seq: "4700" })
      .where(eq(osmRegionImports.slug, "europe/germany/bayern"));
    const geo = new InMemoryGeoClient();
    geo.setRefreshResult("nom_europe_germany_bayern", {
      postgresDb: "nom_europe_germany_bayern",
      appliedDiffs: 0,
      sequence: 4700,
      timestamp: "2026-05-16T11:00:00Z",
    });

    const r = await refreshRegion("europe/germany/bayern", { geo });
    expect(r.ok).toBe(true);
    expect(r.replicationSeq).toBe("4700");
    expect(r.detail).toBe("already up to date");
  });

  it("works for a ready_stopped region (no cold-start needed anymore)", async () => {
    await seedRegion({ slug: "europe/germany/bayern", status: "ready_stopped" });
    const geo = new InMemoryGeoClient();
    geo.setRefreshResult("nom_europe_germany_bayern", {
      postgresDb: "nom_europe_germany_bayern",
      appliedDiffs: 0,
      sequence: null,
      timestamp: null,
    });
    const r = await refreshRegion("europe/germany/bayern", { geo });
    expect(r.ok).toBe(true);
  });

  it("returns ok=false and records last_error on geo failure", async () => {
    await seedRegion({ slug: "europe/germany/bayern" });
    const geo = new InMemoryGeoClient();
    geo.refresh = async () => {
      throw new Error("osm2pgsql-replication update exited with code 1");
    };
    const r = await refreshRegion("europe/germany/bayern", { geo });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("exited with code 1");

    const row = (
      await db.select().from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.last_error).toContain("replication: osm2pgsql-replication update exited");
  });

  it("throws on unknown slug", async () => {
    await expect(refreshRegion("not/here")).rejects.toThrow(/unknown region/);
  });

  it("refuses to refresh a region that's currently importing", async () => {
    await seedRegion({ slug: "europe/germany/bayern", status: "importing" });
    await expect(
      refreshRegion("europe/germany/bayern"),
    ).rejects.toThrow(/can only refresh when ready_/);
  });
});
