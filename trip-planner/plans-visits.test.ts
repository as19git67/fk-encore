/**
 * A booked visit, at the endpoint: the ticket for a sight at 14:00.
 *
 * The arithmetic is covered in frame-visits.test.ts. What is the
 * endpoints' own: an appointment that names its spot puts that spot at
 * its hour on its day, pinned, and takes it out of every other day and
 * out of the pool — and untying it hands the spot back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { addTripFixpoint, setTripFixpointSpot } from "./fixpoint-edit";
import { createTripPlan, type PlanResponse } from "./plans";

const ANCHOR = { lat: 48.37, lon: 10.9 };
const DB = "nom_europe_west";

/** Spots strung out north of the anchor, so a block fits several. */
function spot(n: number): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: ANCHOR.lat + (n * 150) / 111_320,
    lon: ANCHOR.lon,
    distanceM: n * 150,
    detourM: null,
    name: `Sehenswürdigkeit ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["sight"],
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

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `visit-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(user.id),
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
  geo.setSearchSpots(DB, Array.from({ length: 24 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});


type Plan = PlanResponse["plan"];

/** Every day a spot is planned on, by day index. */
function daysWith(plan: Plan, osmRef: string): number[] {
  return plan.legs[0].days
    .filter((d) => d.blocks.some((b) => b.stops.some((s) => s.osmRef === osmRef)))
    .map((d) => d.dayIndex);
}

describe("an appointment that names its spot", () => {
  it("puts the spot at its hour on its day, and nowhere else", async () => {
    const created = await createTripPlan({ legs: [{ anchor: ANCHOR, days: 2 }] });
    const planId = created.plan.id;
    // A spot the planner put on the first day by itself.
    const ref = created.plan.legs[0].days[0].blocks.flatMap((b) => b.stops)[0].osmRef;

    const { plan } = await addTripFixpoint({
      planId,
      dayIndex: 1,
      label: "",
      at: "14:00",
      durationMinutes: 90,
      travelMinutes: 15,
      spotRef: ref,
    });

    const day = plan.legs[0].days[1];
    const fix = day.fixpoints.find((f) => f.spotRef === ref)!;
    // Called after the spot when nobody named it.
    expect(fix.label).toBe("Sehenswürdigkeit " + ref.split(":")[1]);
    expect(fix.blockId).toBeNull();

    // Once, on the day of the ticket — not a second time on the first.
    expect(daysWith(plan, ref)).toEqual([1]);
    expect(plan.legs[0].pool.some((c) => c.osmRef === ref)).toBe(false);

    // In the block that opens with the visit, first and pinned.
    const host = day.blocks.find((b) => b.stops.some((s) => s.osmRef === ref))!;
    expect(host.startMinutes).toBe(13 * 60 + 45);
    expect(host.stops[0].osmRef).toBe(ref);
    expect(host.stops[0].pinned).toBe(true);
    expect(host.stops[0].dwellMinutes).toBe(90);
  });

  it("ties an appointment that is already there, and unties it again", async () => {
    const created = await createTripPlan({
      legs: [{
        anchor: ANCHOR,
        days: 2,
        fixpoints: [{ dayIndex: 1, label: "Tickets Museum", at: "14:00", durationMinutes: 60 }],
      }],
    });
    const planId = created.plan.id;
    const ref = created.plan.legs[0].days[0].blocks.flatMap((b) => b.stops)[0].osmRef;
    const rowId = created.plan.legs[0].days[1].fixpoints[0].rowId;

    const tied = await setTripFixpointSpot({ planId, fixpointId: rowId, spotRef: ref });
    expect(tied.plan.legs[0].days[1].fixpoints[0].spotRef).toBe(ref);
    // The label the traveller gave stays.
    expect(tied.plan.legs[0].days[1].fixpoints[0].label).toBe("Tickets Museum");
    expect(daysWith(tied.plan, ref)).toEqual([1]);

    // A re-plan writes the day's fixpoints anew, so the id is the new one.
    const again = tied.plan.legs[0].days[1].fixpoints[0].rowId;
    const untied = await setTripFixpointSpot({ planId, fixpointId: again, spotRef: null });
    expect(untied.plan.legs[0].days[1].fixpoints[0].spotRef).toBeNull();
    // Free again: wherever the planner wants it, or back in the pool —
    // but no longer pinned to the hour.
    const stops = untied.plan.legs[0].days.flatMap((d) => d.blocks.flatMap((b) => b.stops));
    expect(stops.filter((s) => s.osmRef === ref && s.pinned)).toEqual([]);
  });

  it("refuses a spot this leg does not have, and a departure with a spot", async () => {
    const created = await createTripPlan({ legs: [{ anchor: ANCHOR, days: 1 }] });
    const planId = created.plan.id;
    await expect(addTripFixpoint({
      planId, dayIndex: 0, label: "x", at: "14:00", spotRef: "node:999999",
    })).rejects.toThrow(/gehört nicht zu diesem Reiseabschnitt/);

    const ref = created.plan.legs[0].days[0].blocks.flatMap((b) => b.stops)[0].osmRef;
    await expect(addTripFixpoint({
      planId, dayIndex: 0, label: "Zug", at: "18:00", kind: "departure", spotRef: ref,
    })).rejects.toThrow(/Abfahrt hat keinen Spot/);
  });
});
