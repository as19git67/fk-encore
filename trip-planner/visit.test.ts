/**
 * Reporting a visit, at the endpoint (§6.4, §7.1).
 *
 * The verdict rule is covered in visits.test.ts. What is this
 * endpoint's own is the boundary: what a device is allowed to say, what
 * it is *not* allowed to decide, and what never gets written down at
 * all. A row per geofence crossing would turn a travel diary into a
 * location history, which is the thing §7.1 is keeping off the server.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan } from "./plans";
import { answerTripVisit, listTripVisits, reportVisit } from "./visit";

const ANCHOR = { lat: 48.37, lon: 10.9 };
const DB = "nom_west";

function spot(n: number): GeoPoiSearchSpot {
  const angle = (n / 12) * 2 * Math.PI;
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: ANCHOR.lat + (400 * Math.cos(angle)) / 111_320,
    lon: ANCHOR.lon + (400 * Math.sin(angle)) / (111_320 * Math.cos((ANCHOR.lat * Math.PI) / 180)),
    distanceM: 400,
    detourM: null,
    name: `Sehenswürdigkeit ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: null,
    wikipedia: null,
    openingHours: null,
    cuisine: null,
    wheelchair: null,
    outdoorSeating: null,
    dietVegetarian: null,
    dietVegan: null,
    phone: null,
    website: null,
    facadeAzimuth: null,
  };
}

let geo: InMemoryGeoClient;
let ownerId = 0;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `visit-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = user.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(ownerId),
    permissions: ["photos.view"],
  });
  await db.insert(osmRegionImports).values({
    slug: "europe/west",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: DB,
    bbox_min_lat: 48.2,
    bbox_min_lon: 10.5,
    bbox_max_lat: 48.6,
    bbox_max_lon: 11.2,
    status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  geo.setSearchSpots(DB, Array.from({ length: 12 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function planWithStops() {
  const { plan } = await createTripPlan({ anchor: ANCHOR, days: 1 });
  const stops = plan.legs[0].days[0].blocks.flatMap((b) => b.stops);
  return { plan, stops };
}

describe("POST /trip-planner/plans/:planId/visits", () => {
  it("writes nothing when nothing worth recording happened", async () => {
    // Walking past. A row per geofence crossing would make this a
    // location history rather than a travel diary (§7.1).
    const { plan, stops } = await planWithStops();
    const res = await reportVisit({
      planId: plan.id,
      stopId: stops[0].rowId,
      arrivedAt: "2026-09-05T10:00:00Z",
      leftAt: "2026-09-05T10:03:00Z",
    });

    expect(res.verdict).toBe("none");
    expect(res.visit).toBeNull();
    expect((await listTripVisits({ planId: plan.id })).visits).toEqual([]);
  });

  it("asks when one signal fired", async () => {
    const { plan, stops } = await planWithStops();
    const res = await reportVisit({
      planId: plan.id,
      stopId: stops[0].rowId,
      arrivedAt: "2026-09-05T10:00:00Z",
      leftAt: "2026-09-05T11:00:00Z",
    });

    expect(res.verdict).toBe("suggested");
    expect(res.visit?.confirmed).toBe(false);
    expect(res.visit?.sources).toEqual(["dwell"]);
  });

  it("acts quietly when two signals agree", async () => {
    const { plan, stops } = await planWithStops();
    const res = await reportVisit({
      planId: plan.id,
      stopId: stops[0].rowId,
      arrivedAt: "2026-09-05T10:00:00Z",
      leftAt: "2026-09-05T11:00:00Z",
      hasMatchingPhoto: true,
    });

    expect(res.verdict).toBe("confirmed");
    expect(res.visit?.confirmed).toBe(true);
    expect(res.visit?.sources).toEqual(["dwell", "photo"]);
  });

  it("works out the verdict itself rather than believing the device", async () => {
    // The rule "one asks, two act" is a product decision. A device that
    // sent `confirmed: true` for a three-minute stay must not be able to
    // tick something off.
    const { plan, stops } = await planWithStops();
    const res = await reportVisit({
      planId: plan.id,
      stopId: stops[0].rowId,
      arrivedAt: "2026-09-05T10:00:00Z",
      leftAt: "2026-09-05T10:03:00Z",
      // Deliberately not part of the request type — a hand-written
      // request could still carry it.
      ...({ confirmed: true, sources: ["dwell", "photo"] } as object),
    });
    expect(res.verdict).toBe("none");
  });

  it("measures the dwell against the planned stay, and says which", async () => {
    const { plan, stops } = await planWithStops();
    const res = await reportVisit({
      planId: plan.id,
      stopId: stops[0].rowId,
      arrivedAt: "2026-09-05T10:00:00Z",
      leftAt: "2026-09-05T10:15:00Z",
    });

    // A museum is planned for 90 minutes, so the threshold is 23 — and
    // fifteen minutes is not a visit.
    expect(res.thresholdMinutes).toBe(23);
    expect(res.verdict).toBe("none");
  });

  it("records an unplanned stay, which is the more valuable half", async () => {
    const { plan } = await planWithStops();
    const res = await reportVisit({
      planId: plan.id,
      lat: 48.3712,
      lon: 10.9013,
      name: "Unbekannter Hof",
      arrivedAt: "2026-09-05T13:40:00Z",
      leftAt: "2026-09-05T14:20:00Z",
    });

    expect(res.verdict).toBe("suggested");
    expect(res.visit?.stopId).toBeNull();
    expect(res.visit?.name).toBe("Unbekannter Hof");
    // Nothing was planned there, so the floor applies.
    expect(res.thresholdMinutes).toBe(10);
  });

  it("refuses an unplanned stay with nowhere to put it", async () => {
    const { plan } = await planWithStops();
    await expect(
      reportVisit({ planId: plan.id, arrivedAt: "2026-09-05T13:40:00Z", leftAt: "2026-09-05T14:20:00Z" }),
    ).rejects.toThrow(/needs lat and lon/);
  });

  it("does not double the diary when the same stay arrives twice", async () => {
    // A re-sync, a retried request, a geofence that fired twice.
    const { plan, stops } = await planWithStops();
    const report = () =>
      reportVisit({
        planId: plan.id,
        stopId: stops[0].rowId,
        arrivedAt: "2026-09-05T10:00:00Z",
        leftAt: "2026-09-05T11:00:00Z",
      });

    await report();
    await report();

    expect((await listTripVisits({ planId: plan.id })).visits).toHaveLength(1);
  });

  it("lets a second signal upgrade a stay already reported", async () => {
    const { plan, stops } = await planWithStops();
    await reportVisit({
      planId: plan.id,
      stopId: stops[0].rowId,
      arrivedAt: "2026-09-05T10:00:00Z",
      leftAt: "2026-09-05T11:00:00Z",
    });
    const res = await reportVisit({
      planId: plan.id,
      stopId: stops[0].rowId,
      arrivedAt: "2026-09-05T10:00:00Z",
      leftAt: "2026-09-05T11:00:00Z",
      hasMatchingPhoto: true,
    });

    expect(res.verdict).toBe("confirmed");
    expect((await listTripVisits({ planId: plan.id })).visits).toHaveLength(1);
  });

  it("takes the traveller's word over any inference", async () => {
    const { plan, stops } = await planWithStops();
    const res = await reportVisit({
      planId: plan.id,
      stopId: stops[0].rowId,
      arrivedAt: "2026-09-05T10:00:00Z",
      leftAt: "2026-09-05T10:02:00Z",
      manual: true,
    });
    expect(res.verdict).toBe("confirmed");
  });

  it("refuses timestamps that are not timestamps, or run backwards", async () => {
    const { plan, stops } = await planWithStops();
    await expect(
      reportVisit({ planId: plan.id, stopId: stops[0].rowId, arrivedAt: "gestern" }),
    ).rejects.toThrow(/ISO timestamp/);
    await expect(
      reportVisit({
        planId: plan.id,
        stopId: stops[0].rowId,
        arrivedAt: "2026-09-05T11:00:00Z",
        leftAt: "2026-09-05T10:00:00Z",
      }),
    ).rejects.toThrow(/before arrivedAt/);
  });

  it("does not write into another user's plan", async () => {
    const { plan, stops } = await planWithStops();
    const [other] = await db
      .insert(users)
      .values({ email: `other-${Date.now()}@test.invalid`, name: "Other", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(other.id),
      permissions: ["photos.view"],
    });

    await expect(
      reportVisit({
        planId: plan.id,
        stopId: stops[0].rowId,
        arrivedAt: "2026-09-05T10:00:00Z",
        leftAt: "2026-09-05T11:00:00Z",
      }),
    ).rejects.toThrow(/plan not found/);
  });
});

describe('answering „wart ihr hier?“', () => {
  it("confirms a suggestion", async () => {
    const { plan, stops } = await planWithStops();
    const { visit } = await reportVisit({
      planId: plan.id,
      stopId: stops[0].rowId,
      arrivedAt: "2026-09-05T10:00:00Z",
      leftAt: "2026-09-05T11:00:00Z",
    });

    const res = await answerTripVisit({ planId: plan.id, visitId: visit!.id, confirmed: true });
    expect(res.visit.confirmed).toBe(true);
    expect(res.visit.dismissed).toBe(false);
  });

  it("remembers a no rather than forgetting the stay", async () => {
    // Deleting it would have the next sync re-detect the same stay and
    // ask again — the nagging §6.4 exists to avoid.
    const { plan, stops } = await planWithStops();
    const { visit } = await reportVisit({
      planId: plan.id,
      stopId: stops[0].rowId,
      arrivedAt: "2026-09-05T10:00:00Z",
      leftAt: "2026-09-05T11:00:00Z",
    });

    const res = await answerTripVisit({ planId: plan.id, visitId: visit!.id, confirmed: false });
    expect(res.visit.confirmed).toBe(false);
    expect(res.visit.dismissed).toBe(true);
    expect((await listTripVisits({ planId: plan.id })).visits).toHaveLength(1);
  });

  it("does not answer for someone else", async () => {
    const { plan, stops } = await planWithStops();
    const { visit } = await reportVisit({
      planId: plan.id,
      stopId: stops[0].rowId,
      arrivedAt: "2026-09-05T10:00:00Z",
      leftAt: "2026-09-05T11:00:00Z",
    });

    const [other] = await db
      .insert(users)
      .values({ email: `other-${Date.now()}@test.invalid`, name: "Other", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(other.id),
      permissions: ["photos.view"],
    });

    await expect(
      answerTripVisit({ planId: plan.id, visitId: visit!.id, confirmed: true }),
    ).rejects.toThrow(/visit not found/);
  });
});
