import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
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

// refreshRegion is a stub until the geo service grows a replication
// subprocess (planned for the geo migration's Phase 5). For now the
// contract guarantees: returns ok=true for a ready region, bumps
// last_used_at/updated_at, and rejects on unknown / non-ready slugs.

describe("refreshRegion", () => {
  it("returns ok=true for a ready_running region and bumps last_used_at", async () => {
    await seedRegion({ slug: "europe/germany/bayern" });
    const fixed = new Date("2026-05-16T12:00:00Z");
    const r = await refreshRegion("europe/germany/bayern", { now: () => fixed });
    expect(r.ok).toBe(true);
    expect(r.slug).toBe("europe/germany/bayern");

    const row = (
      await db.select().from(osmRegionImports)
        .where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.last_used_at).toBe("2026-05-16 12:00:00+00");
  });

  it("returns ok=true for a ready_stopped region too (no cold-start needed anymore)", async () => {
    await seedRegion({ slug: "europe/germany/bayern", status: "ready_stopped" });
    const r = await refreshRegion("europe/germany/bayern");
    expect(r.ok).toBe(true);
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
