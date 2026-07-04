import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import { InMemoryGeoClient } from "./geo-client.test-helper";
import {
  isTrustedGeofabrikUrl,
  replicationRetryDelayMs,
  runReplicationHealingPass,
  tickReplicationHealing,
} from "./replication-healer";

const PBF_URL = "https://download.geofabrik.de/europe/germany/sachsen-latest.osm.pbf";

async function seedRegion(overrides: Partial<typeof osmRegionImports.$inferInsert> = {}) {
  await db.insert(osmRegionImports).values({
    slug: "europe/germany/sachsen",
    geofabrik_url: PBF_URL,
    postgres_db: "nom_sachsen",
    bbox_min_lat: 50,
    bbox_min_lon: 11,
    bbox_max_lat: 52,
    bbox_max_lon: 15,
    status: "ready_running",
    ...overrides,
  });
}

beforeEach(async () => {
  await db.delete(osmRegionImports);
});

describe("tickReplicationHealing", () => {
  it("initializes a missing status table with the registered PBF URL", async () => {
    await seedRegion();
    const geo = new InMemoryGeoClient();
    geo.setReplicationStatus("nom_sachsen", false);
    geo.setRefreshResult("nom_sachsen", {
      postgresDb: "nom_sachsen",
      appliedDiffs: 2,
      sequence: 4812,
      timestamp: "2026-07-04T09:00:00Z",
    });
    const fixed = new Date("2026-07-04T10:00:00Z");

    const outcome = await tickReplicationHealing({ geo, now: () => fixed });

    expect(outcome).toMatchObject({ result: "healed", slug: "europe/germany/sachsen" });
    expect(geo.getRefreshCalls()).toEqual(["nom_sachsen"]);
    expect(geo.getRefreshPbfUrls()).toEqual([PBF_URL]);
    const row = (await db.select().from(osmRegionImports))[0]!;
    expect(row.replication_seq).toBe("4812");
    expect(row.replication_failure_count).toBe(0);
    expect(row.replication_next_retry_at).toBe("2026-07-04 10:15:00+00");
    expect(row.replication_last_success_at).toBe("2026-07-04 10:00:00+00");
    expect(row.last_error).toBeNull();
  });

  it("only inspects an already initialized region and persists its sequence", async () => {
    await seedRegion();
    const geo = new InMemoryGeoClient();
    geo.setReplicationStatus("nom_sachsen", true, { sequence: 4800 });

    const outcome = await tickReplicationHealing({ geo });

    expect(outcome.result).toBe("healthy");
    expect(geo.getRefreshCalls()).toEqual([]);
    const row = (await db.select().from(osmRegionImports))[0]!;
    expect(row.replication_seq).toBe("4800");
  });

  it("ignores importing, failed and pending regions", async () => {
    await seedRegion({ status: "importing" });
    const geo = new InMemoryGeoClient();
    geo.setReplicationStatus("nom_sachsen", false);

    expect((await tickReplicationHealing({ geo })).result).toBe("noop");
    expect(geo.getRefreshCalls()).toEqual([]);
  });

  it("rejects untrusted URLs and applies persistent exponential backoff", async () => {
    await seedRegion({ geofabrik_url: "http://example.com/sachsen-latest.osm.pbf" });
    const geo = new InMemoryGeoClient();
    const fixed = new Date("2026-07-04T10:00:00Z");

    const outcome = await tickReplicationHealing({ geo, now: () => fixed });

    expect(outcome.result).toBe("failed");
    expect(geo.getRefreshCalls()).toEqual([]);
    const row = (await db.select().from(osmRegionImports))[0]!;
    expect(row.replication_failure_count).toBe(1);
    expect(row.replication_next_retry_at).toBe("2026-07-04 10:05:00+00");
    expect(row.last_error).toContain("untrusted Geofabrik PBF URL");
  });

  it("does not claim a region before its retry time", async () => {
    await seedRegion({ replication_next_retry_at: "2026-07-04T11:00:00Z" });
    const geo = new InMemoryGeoClient();

    const outcome = await tickReplicationHealing({
      geo,
      now: () => new Date("2026-07-04T10:00:00Z"),
    });

    expect(outcome.result).toBe("noop");
  });

  it("keeps retry state across worker instances and retries when due", async () => {
    await seedRegion();
    const failingGeo = new InMemoryGeoClient();
    failingGeo.getReplicationStatus = async () => {
      throw new Error("geo unavailable");
    };

    expect((await tickReplicationHealing({
      geo: failingGeo,
      now: () => new Date("2026-07-04T10:00:00Z"),
    })).result).toBe("failed");

    const restartedGeo = new InMemoryGeoClient();
    expect((await tickReplicationHealing({
      geo: restartedGeo,
      now: () => new Date("2026-07-04T10:04:59Z"),
    })).result).toBe("noop");
    expect((await tickReplicationHealing({
      geo: failingGeo,
      now: () => new Date("2026-07-04T10:05:00Z"),
    })).result).toBe("failed");
    const failedTwice = (await db.select().from(osmRegionImports))[0]!;
    expect(failedTwice.replication_failure_count).toBe(2);
    expect(failedTwice.replication_next_retry_at).toBe("2026-07-04 10:20:00+00");
    expect((await tickReplicationHealing({
      geo: restartedGeo,
      now: () => new Date("2026-07-04T10:20:00Z"),
    })).result).toBe("healthy");
  });

  it("rejects an unsafe database name without contacting geo", async () => {
    await seedRegion({ postgres_db: "postgres" });
    const geo = new InMemoryGeoClient();

    const outcome = await tickReplicationHealing({ geo });

    expect(outcome.result).toBe("failed");
    expect(outcome.detail).toContain("unsafe postgres database name");
    expect(geo.getRefreshCalls()).toEqual([]);
  });

  it("also heals registered legacy ready_stopped regions", async () => {
    await seedRegion({ status: "ready_stopped" });
    const geo = new InMemoryGeoClient();
    geo.setReplicationStatus("nom_sachsen", false);

    expect((await tickReplicationHealing({ geo })).result).toBe("healed");
  });

  it("allows only one concurrent worker to claim a region", async () => {
    await seedRegion();
    const geo = new InMemoryGeoClient();
    let statusCalls = 0;
    geo.getReplicationStatus = async (postgresDb) => {
      statusCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { postgresDb, initialized: true, sequence: 1, timestamp: null };
    };

    const outcomes = await Promise.all([
      tickReplicationHealing({ geo }),
      tickReplicationHealing({ geo }),
    ]);

    expect(statusCalls).toBe(1);
    expect(outcomes.filter((outcome) => outcome.result === "healthy")).toHaveLength(1);
    expect(outcomes.some((outcome) => outcome.result === "noop" || outcome.result === "locked")).toBe(true);
  });

  it("processes every due region sequentially in one startup pass", async () => {
    await seedRegion();
    await seedRegion({
      slug: "europe/germany/bayern",
      postgres_db: "nom_bayern",
      geofabrik_url: "https://download.geofabrik.de/europe/germany/bayern-latest.osm.pbf",
    });
    const geo = new InMemoryGeoClient();
    geo.setReplicationStatus("nom_sachsen", false);
    geo.setReplicationStatus("nom_bayern", false);
    const fixed = new Date("2026-07-04T10:00:00Z");

    const outcomes = await runReplicationHealingPass({ geo, now: () => fixed });

    expect(outcomes.map((outcome) => outcome.result)).toEqual(["healed", "healed"]);
    expect(geo.getRefreshCalls().sort()).toEqual(["nom_bayern", "nom_sachsen"]);
  });

  it("returns locked while another replica holds the advisory lock", async () => {
    await seedRegion();
    let release!: () => void;
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${622_2026})`);
      acquired();
      await releasePromise;
    });
    await acquiredPromise;

    let outcome;
    try {
      outcome = await tickReplicationHealing({ geo: new InMemoryGeoClient() });
    } finally {
      release();
      await holder;
    }

    expect(outcome!.result).toBe("locked");
  });
});

describe("replication healing policy", () => {
  it("uses 5m, 15m, 1h and then a maximum of 24h", () => {
    expect(replicationRetryDelayMs(1)).toBe(5 * 60_000);
    expect(replicationRetryDelayMs(2)).toBe(15 * 60_000);
    expect(replicationRetryDelayMs(3)).toBe(60 * 60_000);
    expect(replicationRetryDelayMs(4)).toBe(24 * 60 * 60_000);
    expect(replicationRetryDelayMs(20)).toBe(24 * 60 * 60_000);
  });

  it("accepts only HTTPS Geofabrik latest-PBF URLs", () => {
    expect(isTrustedGeofabrikUrl(PBF_URL)).toBe(true);
    expect(isTrustedGeofabrikUrl("http://download.geofabrik.de/x-latest.osm.pbf")).toBe(false);
    expect(isTrustedGeofabrikUrl("https://example.com/x-latest.osm.pbf")).toBe(false);
    expect(isTrustedGeofabrikUrl("https://download.geofabrik.de/x-updates/")).toBe(false);
  });
});
