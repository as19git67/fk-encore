/**
 * The curation job against a real pool (ranking plan, stage 3): a
 * plan's pool write marks the stay as due, the timer asks the model —
 * here a stand-in — and the pool moves into its order without a
 * re-plan, the votes riding along. All places are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripLegCuration, tripPlanPool, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan } from "./plans";
import { curatedScore } from "./candidates";
import { applyCuration, curatedOfLeg, resetCurationAsker, setCurationAsker, tickCuration } from "./curation-job";
import { LlmServiceUnavailableError } from "./llm-client";

const CITY = { lat: 48.37, lon: 10.9 };

function sight(n: number): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`, type: "node", id: n,
    lat: CITY.lat + n * 0.0005, lon: CITY.lon, distanceM: 100 + n, detourM: null,
    name: `Beispielort ${n}`, nameDe: null, nameEn: null,
    kind: "tourism=attraction", categories: ["sight"],
    wikidataQid: null, wikipedia: null,
    openingHours: null, cuisine: null, wheelchair: null, outdoorSeating: null,
    dietVegetarian: null, dietVegan: null, phone: null, website: null, facadeAzimuth: null,
  };
}

let prompts: string[];

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db.insert(users)
    .values({ email: `curation-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "europe/test", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_test",
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.2, status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_test", Array.from({ length: 40 }, (_, i) => sight(i + 1)));
  setGeoClient(geo);
  prompts = [];
});

afterEach(() => {
  resetGeoClient();
  resetCurationAsker();
});

async function plannedLeg() {
  const { plan } = await createTripPlan({ legs: [{ title: "Musterstadt", anchor: CITY, days: 1 }] });
  return { planId: plan.id, legId: plan.legs[0].id };
}

async function poolOf(legId: number) {
  return await db.select().from(tripPlanPool).where(eq(tripPlanPool.leg_id, legId));
}

describe("ordering a stay's pool by the local model", () => {
  it("marks a new stay as due and shows it as being sorted", async () => {
    const { planId, legId } = await plannedLeg();
    const [row] = await db.select().from(tripLegCuration).where(eq(tripLegCuration.leg_id, legId));
    expect(row.status).toBe("pending");
    const { plan } = await getTripPlan({ planId });
    expect(plan.legs[0].curation).toBe("pending");
  });

  it("moves the pool into the model's order, with its sentence first", async () => {
    const { legId } = await plannedLeg();
    const pool = await poolOf(legId);
    // The last entry by score becomes the model's first.
    const ordered = [...pool].sort((a, b) => a.score - b.score).map((r) => r.osm_ref);
    setCurationAsker(async (prompt) => {
      prompts.push(prompt);
      return { order: ordered.map((ref) => ({ ref, why: `Passt gut zu Musterstadt.` })) };
    });

    expect(await tickCuration()).toBe(1);
    expect(prompts[0]).toContain("Musterstadt");
    expect(prompts[0]).not.toContain("Planner");

    const after = await poolOf(legId);
    const best = [...after].sort((a, b) => b.score - a.score)[0];
    expect(best.osm_ref).toBe(ordered[0]);
    expect(best.score).toBe(curatedScore(0, ordered.length));
    expect((best.reasons as string[])[0]).toBe("Passt gut zu Musterstadt.");
    const [row] = await db.select().from(tripLegCuration).where(eq(tripLegCuration.leg_id, legId));
    expect(row.status).toBe("done");
    expect((await curatedOfLeg(legId)).get(ordered[0])?.rank).toBe(0);
  });

  it("keeps what the votes added when the order changes", async () => {
    const { legId } = await plannedLeg();
    const [first] = await poolOf(legId);
    await db.update(tripPlanPool).set({ score: first.score + 25 }).where(eq(tripPlanPool.id, first.id));
    await applyCuration(legId, [{ osmRef: first.osm_ref, reason: "Ein Satz." }]);
    const [after] = (await poolOf(legId)).filter((r) => r.id === first.id);
    expect(after.score).toBe(curatedScore(0, 1) + 25);
    // Asked again with a different order: still the votes on top, one sentence.
    await applyCuration(legId, [{ osmRef: "node:999", reason: null }, { osmRef: first.osm_ref, reason: "Anders." }]);
    const [again] = (await poolOf(legId)).filter((r) => r.id === first.id);
    expect(again.score).toBe(curatedScore(1, 2) + 25);
    expect((again.reasons as string[]).filter((r) => r === "Ein Satz.")).toHaveLength(0);
    expect((again.reasons as string[])[0]).toBe("Anders.");
  });

  it("puts the stay back in the queue when the model is away", async () => {
    const { legId } = await plannedLeg();
    setCurationAsker(async () => { throw new LlmServiceUnavailableError("down"); });
    expect(await tickCuration()).toBe(0);
    const [row] = await db.select().from(tripLegCuration).where(eq(tripLegCuration.leg_id, legId));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
  });

  it("fails a stay whose answer names no place of the pool", async () => {
    const { legId } = await plannedLeg();
    setCurationAsker(async () => ({ order: [{ ref: "way:404", why: "Erfunden." }] }));
    await tickCuration();
    const [row] = await db.select().from(tripLegCuration).where(eq(tripLegCuration.leg_id, legId));
    expect(row.status).toBe("failed");
    expect(row.picks).toBeNull();
  });
});
