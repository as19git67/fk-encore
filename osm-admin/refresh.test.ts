import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import { InMemoryDockerDriver } from "./docker-driver";
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
  it("runs `nominatim replication --once` in the container and persists the new sequence", async () => {
    await seedRegion({ slug: "europe/germany/bayern" });
    const driver = new InMemoryDockerDriver();
    // Simulate the container being up.
    await driver.ensureRunning({ name: "nominatim-europe-germany-bayern", image: "i" });
    driver.execResult = {
      exitCode: 0,
      stdout: "Updating to sequence 4775\nDone.",
      stderr: "",
    };

    const r = await refreshRegion("europe/germany/bayern", { driver });
    expect(r).toMatchObject({ slug: "europe/germany/bayern", ok: true, replicationSeq: "4775" });

    const exec = driver.events.find((e) => e.op === "exec");
    expect(exec).toMatchObject({
      op: "exec",
      name: "nominatim-europe-germany-bayern",
      cmd: ["sudo", "-u", "nominatim", "nominatim", "replication", "--once"],
    });

    const row = (
      await db.select().from(osmRegionImports).where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.replication_seq).toBe("4775");
    expect(row.last_error).toBeNull();
    expect(row.last_used_at).not.toBeNull();
  });

  it("records ok=true even when the output has no sequence id (warm replication, no new diffs)", async () => {
    await seedRegion({ slug: "europe/germany/bayern" });
    const driver = new InMemoryDockerDriver();
    await driver.ensureRunning({ name: "nominatim-europe-germany-bayern", image: "i" });
    driver.execResult = { exitCode: 0, stdout: "Nothing to do.\n", stderr: "" };

    const r = await refreshRegion("europe/germany/bayern", { driver });
    expect(r.ok).toBe(true);
    expect(r.replicationSeq).toBeUndefined();
  });

  it("returns ok=false and records last_error when the command exits non-zero", async () => {
    await seedRegion({ slug: "europe/germany/bayern" });
    const driver = new InMemoryDockerDriver();
    await driver.ensureRunning({ name: "nominatim-europe-germany-bayern", image: "i" });
    driver.execResult = {
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: could not download diff",
    };

    const r = await refreshRegion("europe/germany/bayern", { driver });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("could not download diff");

    const row = (
      await db.select().from(osmRegionImports).where(eq(osmRegionImports.slug, "europe/germany/bayern"))
    )[0];
    expect(row.last_error).toContain("replication exit=1");
  });

  it("throws when the container is not currently running", async () => {
    await seedRegion({ slug: "europe/germany/bayern", status: "ready_stopped" });
    const driver = new InMemoryDockerDriver();
    // Note: container not started → inspect returns 'missing'.
    await expect(
      refreshRegion("europe/germany/bayern", { driver }),
    ).rejects.toThrow(/start the region before refreshing/);
  });

  it("throws on unknown slug", async () => {
    const driver = new InMemoryDockerDriver();
    await expect(refreshRegion("not/here", { driver })).rejects.toThrow(/unknown region/);
  });

  it("refuses to refresh a region that's currently importing", async () => {
    await seedRegion({ slug: "europe/germany/bayern", status: "importing" });
    const driver = new InMemoryDockerDriver();
    await expect(
      refreshRegion("europe/germany/bayern", { driver }),
    ).rejects.toThrow(/can only refresh when ready_/);
  });
});
