import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import {
  osmRegionImports,
  osmRegionRetentionSettings,
  tripPlanLegs,
  tripPlans,
  users,
} from "../db/schema";
import { InMemoryGeoClient } from "./geo-client.test-helper";
import {
  loadRetentionSettings,
  retentionStates,
  runRetentionPass,
  saveRetentionSettings,
  type RegionUseRow,
} from "./retention";

const NOW = new Date("2026-10-21T03:00:00Z");

function row(over: Partial<RegionUseRow> & { slug: string }): RegionUseRow {
  return {
    postgresDb: `nom_${over.slug.replace(/[^a-z0-9]/g, "_")}`,
    status: "ready_running",
    lastUsedAt: null,
    importedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("retentionStates", () => {
  it("is due once the period since the last use has run out", () => {
    const states = retentionStates({
      rows: [
        row({ slug: "old", lastUsedAt: "2026-04-01T00:00:00Z" }),
        row({ slug: "recent", lastUsedAt: "2026-10-01T00:00:00Z" }),
      ],
      tripDatabases: new Set(),
      idleDays: 180,
      now: NOW,
    });
    expect(states.map((s) => [s.slug, s.due])).toEqual([["old", true], ["recent", false]]);
    expect(states[1].removeAfter).toBe("2027-03-30T00:00:00.000Z");
  });

  it("counts from the import, then the creation, when the region was never used", () => {
    const states = retentionStates({
      rows: [
        row({ slug: "imported", importedAt: "2026-09-01T00:00:00Z", createdAt: "2025-01-01T00:00:00Z" }),
        row({ slug: "created", createdAt: "2025-01-01T00:00:00Z" }),
      ],
      tripDatabases: new Set(),
      idleDays: 180,
      now: NOW,
    });
    const bySlug = Object.fromEntries(states.map((s) => [s.slug, s]));
    expect(bySlug.imported.due).toBe(false);
    expect(bySlug.created.due).toBe(true);
  });

  it("keeps a region a trip still needs, however long it lay idle", () => {
    const states = retentionStates({
      rows: [row({ slug: "trip", lastUsedAt: "2025-01-01T00:00:00Z" })],
      tripDatabases: new Set(["nom_trip"]),
      idleDays: 30,
      now: NOW,
    });
    expect(states[0]).toMatchObject({ due: false, keptForTrip: true, removeAfter: null });
  });

  it("leaves imports in flight and pending approvals alone", () => {
    const states = retentionStates({
      rows: [
        row({ slug: "importing", status: "importing" }),
        row({ slug: "pending", status: "pending_approval" }),
        row({ slug: "failed", status: "failed" }),
      ],
      tripDatabases: new Set(),
      idleDays: 30,
      now: NOW,
    });
    expect(states.map((s) => s.slug)).toEqual(["failed"]);
  });
});

describe("runRetentionPass", () => {
  async function seedRegion(slug: string, lastUsedAt: string | null) {
    await db.insert(osmRegionImports).values({
      slug,
      geofabrik_url: "https://example.com/x.pbf",
      postgres_db: `nom_${slug.replace(/[^a-z0-9]/g, "_")}`,
      bbox_min_lat: 47.5,
      bbox_min_lon: 9,
      bbox_max_lat: 50.5,
      bbox_max_lon: 13.5,
      status: "ready_running",
      last_used_at: lastUsedAt,
      imported_at: "2025-01-01T00:00:00Z",
    });
  }

  async function seedTrip(regionDb: string, startDate: string | null) {
    const [user] = await db
      .insert(users)
      .values({ email: `retention-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
      .returning({ id: users.id });
    const [plan] = await db
      .insert(tripPlans)
      .values({ owner_id: user.id, title: "Testreise", constraints: {}, updated_at: "2025-01-01T00:00:00Z" })
      .returning({ id: tripPlans.id });
    await db.insert(tripPlanLegs).values({
      plan_id: plan.id, position: 0, anchor_lat: 48, anchor_lon: 11, region_db: regionDb, start_date: startDate,
    });
  }

  beforeEach(async () => {
    await db.delete(osmRegionImports);
    await db.delete(osmRegionRetentionSettings);
  });

  it("removes regions idle past the period and keeps the rest", async () => {
    await seedRegion("retention/idle", "2026-01-01T00:00:00Z");
    await seedRegion("retention/used", "2026-10-20T00:00:00Z");
    await seedRegion("retention/trip", "2026-01-01T00:00:00Z");
    await seedTrip("nom_retention_trip", "2027-06-01");
    const geo = new InMemoryGeoClient();

    const result = await runRetentionPass({ geo, now: () => NOW });

    expect(result).toMatchObject({ ran: true, removed: ["retention/idle"], failed: [] });
    expect(geo.getDroppedRegions()).toEqual(["nom_retention_idle"]);
    const left = (await db.select({ slug: osmRegionImports.slug }).from(osmRegionImports))
      .map((r) => r.slug)
      .sort();
    expect(left).toEqual(["retention/trip", "retention/used"]);
    const settings = await loadRetentionSettings();
    expect(settings.lastRemoved).toEqual(["retention/idle"]);
    expect(settings.lastRunAt).not.toBeNull();
  });

  it("does not keep a region for a trip long over", async () => {
    await seedRegion("retention/past", "2026-01-01T00:00:00Z");
    await seedTrip("nom_retention_past", "2026-02-01");

    const result = await runRetentionPass({ geo: new InMemoryGeoClient(), now: () => NOW });
    expect(result.removed).toEqual(["retention/past"]);
  });

  it("does nothing while switched off", async () => {
    await seedRegion("retention/idle", "2025-01-01T00:00:00Z");
    await saveRetentionSettings({ enabled: false, idleDays: 30 });
    const geo = new InMemoryGeoClient();

    const result = await runRetentionPass({ geo, now: () => NOW });

    expect(result.ran).toBe(false);
    expect(geo.getDroppedRegions()).toEqual([]);
    const [still] = await db
      .select()
      .from(osmRegionImports)
      .where(eq(osmRegionImports.slug, "retention/idle"));
    expect(still).toBeDefined();
  });

  it("refuses a period shorter than a week", async () => {
    await expect(saveRetentionSettings({ enabled: true, idleDays: 3 })).rejects.toThrow(RangeError);
  });
});
