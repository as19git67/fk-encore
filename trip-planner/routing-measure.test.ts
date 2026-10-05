/**
 * The measurement over the caller's own days (§24, before stage 2):
 * which hops it asks, and the verdict it draws from the answers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { tripPlanBlocks, tripPlanDays, tripPlanLegs, tripPlans, tripPlanStops, users } from "../db/schema";
import { InMemoryRouterClient } from "./router-client.test-helper";
import { setRouterClient } from "./router-client";
import { collectPairs, summarize, type MeasureSample } from "./routing-measure";
import { measureRouting } from "./routing";

const HOTEL = { lat: 48.37, lon: 10.9 };
const A = { lat: 48.375, lon: 10.905 };
const B = { lat: 48.38, lon: 10.91 };

let router: InMemoryRouterClient;
let ownerId = 0;

async function newUser(tag: string): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({ email: `measure-${tag}-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  return user.id;
}

/** One plan, one leg, one day with the given stops in one block. */
async function seedDay(owner: number, opts: { mode?: string; kind?: string; stops: Array<{ lat: number; lon: number; name: string }> }) {
  const [plan] = await db.insert(tripPlans).values({ owner_id: owner, title: "Testreise", constraints: {} })
    .returning({ id: tripPlans.id });
  const [leg] = await db.insert(tripPlanLegs).values({
    plan_id: plan.id, position: 0, anchor_lat: HOTEL.lat, anchor_lon: HOTEL.lon, anchor_label: "Hotel",
    mode: opts.mode ?? "foot", kind: opts.kind ?? "stay", region_db: "nom_x",
  }).returning({ id: tripPlanLegs.id });
  const [day] = await db.insert(tripPlanDays).values({ leg_id: leg.id, day_index: 0 })
    .returning({ id: tripPlanDays.id });
  const [block] = await db.insert(tripPlanBlocks).values({
    day_id: day.id, position: 0, template_id: "morning", label: "Vormittag", kind: "explore", budget_minutes: 180,
  }).returning({ id: tripPlanBlocks.id });
  if (opts.stops.length > 0) {
    await db.insert(tripPlanStops).values(opts.stops.map((s, i) => ({
      block_id: block.id, position: i, osm_ref: `node:${i + 1}`, name: s.name,
      lat: s.lat, lon: s.lon, category: "museum", dwell_minutes: 30,
    })));
  }
  return plan.id;
}

beforeEach(async () => {
  await db.delete(tripPlans);
  ownerId = await newUser("owner");
  vi.mocked(getAuthData).mockReturnValue({ userID: String(ownerId), permissions: ["photos.view"] });
  router = new InMemoryRouterClient();
  setRouterClient(router);
  return () => setRouterClient(null);
});

describe("collectPairs", () => {
  it("walks the day from the quarters through the stops and back", async () => {
    await seedDay(ownerId, { stops: [{ ...A, name: "Museum" }, { ...B, name: "Dom" }] });
    const pairs = await collectPairs(ownerId);
    expect(pairs.map((p) => `${p.from.label}→${p.to.label}`)).toEqual([
      "Hotel→Museum", "Museum→Dom", "Dom→Hotel",
    ]);
    expect(pairs.every((p) => p.mode === "foot")).toBe(true);
  });

  it("leaves out transit, journeys between cities, and other people's trips", async () => {
    await seedDay(ownerId, { mode: "transit", stops: [{ ...A, name: "Museum" }] });
    await seedDay(ownerId, { kind: "transit", mode: "car", stops: [{ ...A, name: "Rast" }] });
    const other = await newUser("other");
    await seedDay(other, { stops: [{ ...A, name: "Fremd" }] });
    expect(await collectPairs(ownerId)).toEqual([]);
  });
});

describe("summarize", () => {
  const sample = (estimate: number, routed: number | null, mode: MeasureSample["mode"] = "car"): MeasureSample => ({
    mode, planTitle: null,
    from: { ...A, label: "a" }, to: { ...B, label: "b" },
    estimateMinutes: estimate, routerMinutes: routed,
  });

  it("counts a hop as off only past a quarter and past a few minutes", () => {
    const result = summarize([
      sample(10, 11),   // 10 % — fine
      sample(2, 4),     // 100 %, but two minutes — noise
      sample(20, 40),   // 50 % and 20 minutes — off
      sample(30, null), // no way found
    ]);
    expect(result.modes).toEqual([{
      mode: "car", pairs: 4, answered: 3, offByQuarter: 1,
      medianDeviationPct: 50, medianDifferenceMinutes: 2,
    }]);
    expect(result.worst).toHaveLength(1);
    expect(result.worst[0]).toMatchObject({ estimateMinutes: 20, routerMinutes: 40 });
    expect(result.worthwhile).toBe(true);
  });

  it("says it is not worth it when the estimate holds", () => {
    expect(summarize([sample(10, 11), sample(20, 21), sample(30, 28)]).worthwhile).toBe(false);
    expect(summarize([]).worthwhile).toBe(false);
  });
});

describe("POST /trip-planner/routing/measure", () => {
  it("asks the router once per hop and reports per mode", async () => {
    await seedDay(ownerId, { stops: [{ ...A, name: "Museum" }, { ...B, name: "Dom" }] });
    const res = await measureRouting();
    expect(res.pairs).toBe(3);
    expect(router.routeCalls).toEqual(["foot", "foot", "foot"]);
    expect(res.modes[0]).toMatchObject({ mode: "foot", pairs: 3, answered: 3 });
  });

  it("measures nothing, and says so, when the router is away", async () => {
    await seedDay(ownerId, { stops: [{ ...A, name: "Museum" }] });
    router.reachable = false;
    const res = await measureRouting();
    expect(res.pairs).toBe(2);
    expect(res.modes[0]).toMatchObject({ answered: 0, medianDeviationPct: null });
    expect(res.worthwhile).toBe(false);
  });
});
