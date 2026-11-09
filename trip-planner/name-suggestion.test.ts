import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { buildNamePrompt, parseName, suggestTripName } from "./name-suggestion";
import { createTripPlan, updateTripSettings } from "./plans";

const TOWN = { lat: 48.37, lon: 10.9 };

/** The canned model: whatever it is asked, this is the answer. */
function stubModel(answer: unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } }));
}

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `name-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "europe/test", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_test",
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.2, status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_test", []);
  setGeoClient(geo);
  return () => {
    resetGeoClient();
    vi.restoreAllMocks();
  };
});

async function trip(title?: string) {
  const { plan } = await createTripPlan({
    ...(title ? { title } : {}),
    legs: [{ title: "Musterstadt", anchor: TOWN, days: 3, startDate: "2026-11-23" }],
  });
  return plan;
}

describe("buildNamePrompt", () => {
  it("names the stays with their days and the month the trip starts in", () => {
    const prompt = buildNamePrompt({
      legs: [
        { kind: "stay", position: 1, title: "Küstenstadt", anchorLabel: null, days: [{}, {}], startDate: "2026-12-01" },
        { kind: "stay", position: 0, title: "Musterstadt", anchorLabel: null, days: [{}, {}, {}], startDate: "2026-11-23" },
      ] as never,
    });
    expect(prompt).toContain("- Musterstadt (3 Tage)\n- Küstenstadt (2 Tage)");
    expect(prompt).toContain("im November 2026");
  });
});

describe("parseName", () => {
  it("keeps a short name without quotes and refuses anything else", () => {
    expect(parseName({ name: "„Musterstadt im November“" })).toBe("Musterstadt im November");
    expect(parseName({ name: "" })).toBeNull();
    expect(parseName({ name: "x".repeat(41) })).toBeNull();
    expect(parseName({ title: "Musterstadt" })).toBeNull();
    expect(parseName("Musterstadt")).toBeNull();
  });
});

describe("POST /trip-planner/plans/:planId/name-suggestion", () => {
  it("writes the model's name on a trip without one", async () => {
    const plan = await trip();
    stubModel({ name: "Musterstadt im November" });
    const res = await suggestTripName({ planId: plan.id });
    expect(res).toEqual({ title: "Musterstadt im November", written: true });
    const [row] = await db.select({ title: tripPlans.title }).from(tripPlans);
    expect(row.title).toBe("Musterstadt im November");
  });

  it("never replaces a name somebody gave", async () => {
    const plan = await trip("Unsere Reise");
    const fetch = stubModel({ name: "Musterstadt im November" });
    const res = await suggestTripName({ planId: plan.id });
    expect(res).toEqual({ title: "Unsere Reise", written: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("writes nothing when the model gives no usable name", async () => {
    const plan = await trip();
    stubModel({ name: "" });
    expect(await suggestTripName({ planId: plan.id })).toEqual({ title: null, written: false });
  });

  it("lets a name typed afterwards win", async () => {
    const plan = await trip();
    stubModel({ name: "Musterstadt im November" });
    await suggestTripName({ planId: plan.id });
    await updateTripSettings({ planId: plan.id, title: "Herbst" });
    expect(await suggestTripName({ planId: plan.id })).toEqual({ title: "Herbst", written: false });
  });
});
