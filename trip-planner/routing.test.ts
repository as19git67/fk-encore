/**
 * The router's status and the measurement, through the endpoints.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import { InMemoryRouterClient } from "./router-client.test-helper";
import { setRouterClient } from "./router-client";
import { compareTravel, routingStatus, tilesBehind } from "./routing";

let router: InMemoryRouterClient;

beforeEach(async () => {
  vi.mocked(getAuthData).mockReturnValue({ userID: "1", permissions: ["photos.view"] });
  await db.delete(osmRegionImports);
  router = new InMemoryRouterClient();
  setRouterClient(router);
  return () => setRouterClient(null);
});

describe("GET /trip-planner/routing/status", () => {
  it("says the tiles are behind when a region came after them", async () => {
    await db.insert(osmRegionImports).values({
      slug: "europe/x", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_x",
      bbox_min_lat: 48, bbox_min_lon: 10, bbox_max_lat: 49, bbox_max_lon: 11,
      status: "ready_running", imported_at: "2026-09-20T10:00:00.000Z",
    });
    router.tilesBuiltAt = "2026-09-01T00:00:00.000Z";
    const status = await routingStatus();
    expect(status).toMatchObject({ reachable: true, hasTiles: true, tilesBehindRegion: true });
    expect(status.newestRegionAt).toContain("2026-09-20");

    router.tilesBuiltAt = "2026-09-21T00:00:00.000Z";
    expect((await routingStatus()).tilesBehindRegion).toBe(false);
  });

  it("is honest about a router that is away", async () => {
    router.reachable = false;
    expect(await routingStatus()).toMatchObject({
      reachable: false, hasTiles: false, tilesBuiltAt: null, tilesBehindRegion: false,
    });
  });

  it("compares nothing when either side is unknown", () => {
    expect(tilesBehind(null, "2026-09-20T10:00:00.000Z")).toBe(false);
    expect(tilesBehind("2026-09-01T00:00:00.000Z", null)).toBe(false);
  });
});

describe("POST /trip-planner/routing/compare", () => {
  const from = { lat: 48.37, lon: 10.9 };
  const to = { lat: 48.6, lon: 11.3 };

  it("puts the estimate next to the router", async () => {
    const res = await compareTravel({ from, to, mode: "car" });
    expect(res.mode).toBe("car");
    expect(res.estimate.minutes).toBeGreaterThan(0);
    expect(res.router?.minutes).toBeGreaterThan(0);
    expect(res.differenceMinutes).toBe((res.router?.minutes ?? 0) - res.estimate.minutes);
    expect(router.routeCalls).toEqual(["car"]);
  });

  it("keeps the estimate and says the router had no answer", async () => {
    router.reachable = false;
    const res = await compareTravel({ from, to });
    expect(res.router).toBeNull();
    expect(res.differenceMinutes).toBeNull();
    expect(res.estimate.minutes).toBeGreaterThan(0);
  });

  it("refuses what is not a coordinate", async () => {
    await expect(compareTravel({ from: { lat: 95, lon: 0 }, to })).rejects.toMatchObject({ code: "invalid_argument" });
  });
});
