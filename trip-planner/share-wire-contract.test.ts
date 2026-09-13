/**
 * The server's half of the share extension's wire contract (§9.2).
 *
 * `ios/F4milShare/ShareWireTypes.swift` is a hand-written mirror of what
 * these endpoints return, and nothing on the Swift side can notice when
 * this side moves: the extension compiles against no schema, and a
 * missing key surfaces as a `JSONDecoder` throwing on a device — behind
 * a `try?`, as an empty list, months later.
 *
 * So this pins the keys that mirror depends on. It is deliberately not
 * an exact key comparison: adding a field breaks nobody, and a test
 * that fails for it would be noise. Renaming or dropping one of these,
 * though, breaks a screen nobody would connect to the change — and that
 * is what this catches, here, in the commit that does it.
 *
 * The Swift half is `ios/Tests/F4milShareWireTests`, which decodes
 * fixtures of these shapes through the real types. Both halves are
 * needed: a fixture and a mirror can agree perfectly with each other
 * while the server has long since moved on.
 *
 * One limit worth knowing: these call the handlers directly, so what is
 * inspected is the object the handler returns, not the JSON the gateway
 * writes. That is enough for the keys — the mirror's non-optional
 * fields (`isMapLink`, `own`, `ownerId`) are never null and never
 * omitted — but a serialisation quirk affecting nulls would slip
 * through, and only a device would notice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { ideaPool, ideaPoolShares, osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { listIdeas } from "./ideas";
import { readMapLink } from "./map-link-read";
import { createTripPlan, listTripPlans } from "./plans";
import { analyseShare } from "./share";

/** What `SharePlanSummary` reads. */
const PLAN_KEYS = ["id", "title", "legTitles"];
/** What `ShareIdeaCollection` reads — `label` is derived on the client. */
const COLLECTION_KEYS = ["ownerId", "ownerName", "own"];
/** What `ShareMapLinkRead` reads. */
const MAP_LINK_KEYS = ["isMapLink", "lat", "lon", "name", "unresolved"];
/** What `ShareAnalyzeResponse` reads. */
const ANALYSE_KEYS = ["kind", "sourceUrl", "proposals", "rejected"];
/** What `ShareProposal` reads. */
const PROPOSAL_KEYS = [
  "name", "verdict", "position", "osmRef", "categories", "legIndex",
  "options", "quote", "placeHint",
];

const ANCHOR = { lat: 43.47, lon: 11.04 };

let geo: InMemoryGeoClient;
let userId: number;

beforeEach(async () => {
  await db.delete(ideaPool);
  await db.delete(ideaPoolShares);
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `wire-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  userId = user.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(user.id),
    permissions: ["photos.view"],
  });
  await db.insert(osmRegionImports).values({
    slug: "europe/italy/toscana",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: "nom_toscana",
    bbox_min_lat: 42.2,
    bbox_min_lon: 9.6,
    bbox_max_lat: 44.5,
    bbox_max_lon: 12.4,
    status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_toscana", []);
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("what the share extension decodes", () => {
  it("sends every key SharePlanSummary reads", async () => {
    await createTripPlan({ legs: [{ title: "San Gimignano", anchor: ANCHOR }] });

    const res = await listTripPlans();

    expect(res.plans.length).toBeGreaterThan(0);
    expect(Object.keys(res.plans[0])).toEqual(expect.arrayContaining(PLAN_KEYS));
    // `legTitles` is an array on the wire, and Swift reads it as
    // `[String?]` — a single string here would decode as nothing.
    expect(Array.isArray(res.plans[0].legTitles)).toBe(true);
  });

  it("sends every key ShareIdeaCollection reads, and no label", async () => {
    const res = await listIdeas({});

    const own = res.collections.find((c) => c.own);
    expect(own).toBeDefined();
    expect(Object.keys(own!)).toEqual(expect.arrayContaining(COLLECTION_KEYS));
    // The bug this file exists for: the extension asked for a `label`,
    // decoding threw on every response, and the picker fell back to
    // demanding a trip. If a label is ever added here, the mirror may
    // adopt it — but it must never be *expected* while absent.
    expect(own).not.toHaveProperty("label");
  });

  it("names a shared collection's owner, because the label is built from it", async () => {
    const [other] = await db
      .insert(users)
      .values({ email: `other-${Date.now()}@test.invalid`, name: "Anna", password_hash: "x" })
      .returning({ id: users.id });
    await db.insert(ideaPoolShares).values({ owner_id: other.id, user_id: userId });

    const res = await listIdeas({});
    const shared = res.collections.find((c) => !c.own);

    expect(shared?.ownerName).toBe("Anna");
  });

  it("sends every key ShareMapLinkRead reads", async () => {
    const res = await readMapLink({ url: "geo:43.4674,11.0431" });

    expect(Object.keys(res)).toEqual(expect.arrayContaining(MAP_LINK_KEYS));
    expect(typeof res.isMapLink).toBe("boolean");
    // Swift reads these two as non-optional `Bool`. A null would throw.
    expect(res.unresolved).not.toBeNull();
    expect(res.isMapLink).not.toBeNull();
  });

  it("sends every key the analysis and its proposals read", async () => {
    const { plan } = await createTripPlan({ legs: [{ title: "San Gimignano", anchor: ANCHOR }] });

    const res = await analyseShare({ planId: plan.id, url: "geo:43.4674,11.0431" });

    expect(Object.keys(res)).toEqual(expect.arrayContaining(ANALYSE_KEYS));
    expect(res.proposals.length).toBeGreaterThan(0);
    expect(Object.keys(res.proposals[0])).toEqual(expect.arrayContaining(PROPOSAL_KEYS));
    // Both are arrays in Swift with no optionality to fall back on.
    expect(Array.isArray(res.rejected)).toBe(true);
    expect(Array.isArray(res.proposals[0].options)).toBe(true);
    expect(Array.isArray(res.proposals[0].categories)).toBe(true);
  });
});
