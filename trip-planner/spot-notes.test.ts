/**
 * Notes, titles and links on individual spots (§9.2, §10.4).
 *
 * The cases that matter are the ones about *survival*: a sentence
 * somebody wrote has to still be there after the plan is recomputed,
 * and after the spot moves out of the pool onto a day. Every re-plan
 * deletes and rewrites the stop rows, so anything hanging off a row is
 * lost silently — which is the kind of loss nobody reports and
 * everybody stops trusting.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan, updateTripSettings } from "./plans";
import { placeFromPool } from "./pool";
import { saveTripSpotNote } from "./spot-notes";

const WEST = { lat: 48.37, lon: 10.9 };

function spot(n: number): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: WEST.lat + n * 0.0006,
    lon: WEST.lon,
    distanceM: n * 70,
    detourM: null,
    name: `Museum ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: `Q${n}`,
    wikipedia: `de:Museum ${n}`,
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

/** A place whose only name is one a German reader cannot read (§10.4). */
function japaneseSpot(): GeoPoiSearchSpot {
  return {
    ...spot(20),
    osmRef: "node:20",
    id: 20,
    name: "東京国立博物館",
    nameDe: "Nationalmuseum Beispielstadt",
    nameEn: "Example City National Museum",
    wikipedia: "ja:東京国立博物館",
  };
}

let ownerId = 0;

function actAs(userId: number) {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(userId),
    permissions: ["photos.view"],
  });
}

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = Date.now() + Math.random();
  const [row] = await db
    .insert(users)
    .values({ email: `notes-${stamp}@test.invalid`, name: "Planerin", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = row.id;
  actAs(ownerId);

  await db.insert(osmRegionImports).values({
    slug: "europe/west",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: "nom_west",
    bbox_min_lat: 48.2,
    bbox_min_lon: 10.5,
    bbox_max_lat: 48.6,
    bbox_max_lon: 11.2,
    status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", [
    ...Array.from({ length: 12 }, (_, i) => spot(i + 1)),
    japaneseSpot(),
  ]);
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function plannedTrip() {
  const { plan } = await createTripPlan({ legs: [{ title: "Weststadt", anchor: WEST }] });
  return plan;
}

type Plan = Awaited<ReturnType<typeof plannedTrip>>;

function everySpot(plan: Plan) {
  return [
    ...plan.legs[0].pool,
    ...plan.legs[0].days.flatMap((d) => d.blocks.flatMap((b) => b.stops)),
  ];
}

function find(plan: Plan, osmRef: string) {
  const found = everySpot(plan).find((s) => s.osmRef === osmRef);
  if (!found) throw new Error(`${osmRef} is neither in the pool nor on a day`);
  return found;
}

function anyRef(plan: Plan): string {
  return everySpot(plan)[0].osmRef;
}

describe("writing something about a spot", () => {
  it("keeps the note, the title and the link", async () => {
    const plan = await plannedTrip();
    const osmRef = anyRef(plan);

    await saveTripSpotNote({
      planId: plan.id,
      legIndex: 0,
      osmRef,
      title: "Das mit dem Dachgarten",
      note: "Tickets vorher kaufen, der Eingang ist um die Ecke.",
      url: "https://beispiel.test/museum",
    });

    const { plan: after } = await getTripPlan({ planId: plan.id });
    const written = find(after, osmRef);
    expect(written.title).toBe("Das mit dem Dachgarten");
    expect(written.note).toBe("Tickets vorher kaufen, der Eingang ist um die Ecke.");
    expect(written.sourceUrl).toBe("https://beispiel.test/museum");
  });

  it("leaves alone the fields the caller did not mention", async () => {
    // A screen that edits only the note must not wipe the link.
    const plan = await plannedTrip();
    const osmRef = anyRef(plan);
    await saveTripSpotNote({
      planId: plan.id, legIndex: 0, osmRef,
      note: "Erst am Nachmittag hin.", url: "https://beispiel.test/museum",
    });

    await saveTripSpotNote({ planId: plan.id, legIndex: 0, osmRef, note: "Doch lieber früh." });

    const written = find(await getTripPlan({ planId: plan.id }).then((r) => r.plan), osmRef);
    expect(written.note).toBe("Doch lieber früh.");
    expect(written.sourceUrl).toBe("https://beispiel.test/museum");
  });

  it("clears a field when the caller sends an empty one", async () => {
    const plan = await plannedTrip();
    const osmRef = anyRef(plan);
    await saveTripSpotNote({ planId: plan.id, legIndex: 0, osmRef, note: "Doch nicht." });

    const { spotNote } = await saveTripSpotNote({
      planId: plan.id, legIndex: 0, osmRef, note: "",
    });

    // Nothing left to say, so nothing is kept — the spot goes back to
    // showing whatever the find brought with it.
    expect(spotNote).toBeNull();
    expect(find(await getTripPlan({ planId: plan.id }).then((r) => r.plan), osmRef).note).toBeNull();
  });

  it("survives a re-plan", async () => {
    // Every settings change deletes the day's stops and writes them
    // again. A note kept on the row would last exactly until then.
    const plan = await plannedTrip();
    const osmRef = anyRef(plan);
    await saveTripSpotNote({
      planId: plan.id, legIndex: 0, osmRef, note: "Eingang um die Ecke.",
    });

    await updateTripSettings({ planId: plan.id, pace: "relaxed" });

    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(find(after, osmRef).note).toBe("Eingang um die Ecke.");
  });

  it("follows the spot from the pool onto a day", async () => {
    const plan = await plannedTrip();
    const waiting = plan.legs[0].pool[0].osmRef;
    await saveTripSpotNote({
      planId: plan.id, legIndex: 0, osmRef: waiting, title: "Der Geheimtipp",
    });
    const block = plan.legs[0].days[0].blocks.find((b) => b.kind === "spots")!;

    const { plan: after } = await placeFromPool({
      planId: plan.id, dayIndex: 0, blockId: block.id, osmRef: waiting,
    });

    const placed = after.legs[0].days[0].blocks
      .flatMap((b) => b.stops)
      .find((s) => s.osmRef === waiting);
    expect(placed?.title).toBe("Der Geheimtipp");
  });

  it("refuses a spot this leg has never heard of", async () => {
    const plan = await plannedTrip();
    await expect(
      saveTripSpotNote({ planId: plan.id, legIndex: 0, osmRef: "node:999999", note: "x" }),
    ).rejects.toThrow(/Etappe/);
  });

  it("refuses a link the app could not open", async () => {
    const plan = await plannedTrip();
    const osmRef = anyRef(plan);
    await expect(
      saveTripSpotNote({ planId: plan.id, legIndex: 0, osmRef, url: "nicht mal eine URL" }),
    ).rejects.toThrow(/url/);
    await expect(
      saveTripSpotNote({ planId: plan.id, legIndex: 0, osmRef, url: "javascript:alert(1)" }),
    ).rejects.toThrow(/http/);
  });
});

describe("what the map already knows about a spot", () => {
  it("keeps the local name beside the readable one", async () => {
    const plan = await plannedTrip();
    const japanese = find(plan, "node:20");

    // The name to plan with, and the one written on the building.
    expect(japanese.name).toBe("Nationalmuseum Beispielstadt");
    expect(japanese.localName).toBe("東京国立博物館");
  });

  it("says nothing about a local name when it is the readable one", async () => {
    // Most of Europe: a second identical line would be noise.
    const plan = await plannedTrip();
    expect(find(plan, "node:1").localName).toBeNull();
  });

  it("carries the Wikipedia article the map points at", async () => {
    const plan = await plannedTrip();
    expect(find(plan, "node:1").wikipediaUrl).toBe("https://de.wikipedia.org/wiki/Museum_1");
    expect(find(plan, "node:20").wikipediaUrl).toBe(
      "https://ja.wikipedia.org/wiki/%E6%9D%B1%E4%BA%AC%E5%9B%BD%E7%AB%8B%E5%8D%9A%E7%89%A9%E9%A4%A8",
    );
  });

  it("keeps both when the spot is placed by hand", async () => {
    const plan = await plannedTrip();
    const waiting = plan.legs[0].pool.find((c) => c.osmRef === "node:20");
    if (!waiting) return; // already planned — the placement case is moot
    const block = plan.legs[0].days[0].blocks.find((b) => b.kind === "spots")!;

    const { plan: after } = await placeFromPool({
      planId: plan.id, dayIndex: 0, blockId: block.id, osmRef: "node:20",
    });

    const placed = find(after, "node:20");
    expect(placed.localName).toBe("東京国立博物館");
    expect(placed.wikipediaUrl).toContain("ja.wikipedia.org");
  });
});
