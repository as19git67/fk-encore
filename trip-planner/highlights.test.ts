/**
 * The highlights of a stay and the category search (ideas plan, stage 2).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports, tripLegHighlights, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan } from "./plans";
import { tripHighlights, orderBy } from "./highlights";
import { tickHighlights } from "./highlights-job";
import { resetCurationAsker, setCurationAsker } from "./curation-job";
import { searchPlaces } from "./search";
import { addFind } from "./add-find";
import { LlmServiceUnavailableError } from "./llm-client";

const TOWN = { lat: 48.37, lon: 10.9 };

function spot(n: number, opts: { famous?: boolean; category?: string } = {}): GeoPoiSearchSpot {
  const famous = opts.famous ?? true;
  return {
    osmRef: `node:${n}`, type: "node", id: n, lat: TOWN.lat + n * 0.002, lon: TOWN.lon, distanceM: 10, detourM: null,
    name: `Beispielplatz ${n}`, nameDe: null, nameEn: null,
    kind: famous ? "tourism=museum" : "amenity=bench",
    categories: [opts.category ?? "museum"],
    wikidataQid: famous ? `Q${n}` : null, wikipedia: famous ? `de:Beispiel ${n}` : null,
    openingHours: null, cuisine: null, wheelchair: null, outdoorSeating: null,
    dietVegetarian: null, dietVegan: null, phone: null, website: null, facadeAzimuth: null,
  };
}

let geo: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `highlights-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "europe/west", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_west",
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.6, status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", [
    spot(1), spot(2), spot(3), spot(4, { category: "viewpoint" }), spot(5, { famous: false }),
  ]);
  setGeoClient(geo);
});

afterEach(() => {
  resetGeoClient();
  resetCurationAsker();
});

async function emptyTrip() {
  const { plan } = await createTripPlan({
    startEmpty: true,
    legs: [{ title: "Musterstadt", anchor: TOWN, days: 3, radiusM: 4_000, startDate: "2026-09-05" }],
  });
  return plan;
}

describe("the highlights of a stay", () => {
  it("lists what is known around it and writes nothing to the trip", async () => {
    const plan = await emptyTrip();
    const res = await tripHighlights({ planId: plan.id, legIndex: 0 });

    // The bench with nothing to say for it is not a highlight.
    expect(res.results.map((r) => r.osmRef).sort()).toEqual(["node:1", "node:2", "node:3", "node:4"]);
    expect(res.results[0].reason).not.toBeNull();
    expect(res.results.every((r) => !r.inPool && !r.planned)).toBe(true);
    expect(res.unavailable).toBe(false);
    // Asked for in the background, so the list says it is still sorting.
    expect(res.sorting).toBe(true);
    const legId = plan.legs[0].id;
    const [row] = await db.select().from(tripLegHighlights).where(eq(tripLegHighlights.leg_id, legId));
    expect(row.status).toBe("pending");

    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(after.legs[0].pool).toEqual([]);
  });

  it("follows the model's order once it has answered", async () => {
    const plan = await emptyTrip();
    await tripHighlights({ planId: plan.id, legIndex: 0 });
    const prompts: string[] = [];
    setCurationAsker(async (prompt) => {
      prompts.push(prompt);
      return { order: [
        { ref: "node:3", why: "Das bekannteste Haus von Musterstadt." },
        { ref: "node:1", why: "Klein, aber sehenswert." },
      ] };
    });
    expect(await tickHighlights()).toBe(1);
    expect(prompts[0]).toContain("Musterstadt");
    expect(prompts[0]).not.toContain("Planner");

    const res = await tripHighlights({ planId: plan.id, legIndex: 0 });
    expect(res.sorting).toBe(false);
    expect(res.results.slice(0, 2).map((r) => r.osmRef)).toEqual(["node:3", "node:1"]);
    expect(res.results[0].reason).toBe("Das bekannteste Haus von Musterstadt.");
    // The places the model left out stay on the list, after its picks.
    expect(res.results).toHaveLength(4);
  });

  it("keeps the stay pending while the model is away", async () => {
    const plan = await emptyTrip();
    await tripHighlights({ planId: plan.id, legIndex: 0 });
    setCurationAsker(async () => { throw new LlmServiceUnavailableError("down"); });
    expect(await tickHighlights()).toBe(0);
    const res = await tripHighlights({ planId: plan.id, legIndex: 0 });
    expect(res.sorting).toBe(true);
  });

  it("pages on and marks what is already an idea", async () => {
    const plan = await emptyTrip();
    const first = await tripHighlights({ planId: plan.id, legIndex: 0, limit: 2 });
    expect(first.results).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const rest = await tripHighlights({ planId: plan.id, legIndex: 0, offset: 2, limit: 2 });
    expect(rest.hasMore).toBe(false);
    expect(new Set([...first.results, ...rest.results].map((r) => r.osmRef)).size).toBe(4);

    const pick = first.results[0];
    await addFind({ planId: plan.id, lat: pick.lat, lon: pick.lon, name: pick.name ?? undefined, legIndex: 0 });
    const { plan: after } = await getTripPlan({ planId: plan.id });
    const added = after.legs[0].pool[0];
    const again = await tripHighlights({ planId: plan.id, legIndex: 0 });
    expect(again.results.find((r) => r.osmRef === added.osmRef)?.inPool).toBe(true);
  });

  it("says when the region did not answer", async () => {
    const plan = await emptyTrip();
    geo.failSearchFor("nom_west");
    const res = await tripHighlights({ planId: plan.id, legIndex: 0 });
    expect(res.unavailable).toBe(true);
    expect(res.results).toEqual([]);
  });
});

describe("ordering by the model's picks", () => {
  it("puts the picks first and keeps the rest by fame", () => {
    const ranked = ["a", "b", "c"].map((osmRef, i) => ({
      osmRef, name: osmRef, lat: 0, lon: 0, category: "museum", dwellMinutes: 30, score: 3 - i,
      reasons: ["hat einen Wikipedia-Artikel"],
    }));
    const out = orderBy(ranked, [{ osmRef: "c", reason: "Zuerst." }, { osmRef: "x", reason: "Erfunden." }]);
    expect(out.map((o) => o.candidate.osmRef)).toEqual(["c", "a", "b"]);
    expect(out[0].reason).toBe("Zuerst.");
    expect(out[1].reason).toBe("hat einen Wikipedia-Artikel");
  });
});

describe("searching by category", () => {
  it("finds every place of a category without a name", async () => {
    const plan = await emptyTrip();
    const res = await searchPlaces({ planId: plan.id, query: "", categories: ["viewpoint"], legIndex: 0 });
    const call = geo.getSearchCalls().at(-1)!;
    expect(call.query.name).toBeUndefined();
    expect(call.query.categories).toEqual(["viewpoint"]);
    expect(res.results.map((r) => r.osmRef)).toContain("node:4");
  });

  it("still wants two characters when no category is given", async () => {
    const plan = await emptyTrip();
    await expect(searchPlaces({ planId: plan.id, query: "" })).rejects.toThrow(/mindestens/);
  });
});
