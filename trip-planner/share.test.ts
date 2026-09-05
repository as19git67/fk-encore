/**
 * What comes out of the share sheet, at the endpoint (§9.2, §9.3).
 *
 * The cases worth holding down are the ones where being wrong is
 * quiet: a name resolved to the wrong branch of a café, an invented
 * recommendation that nobody notices is invented, and a page fetch that
 * a hostile article steers into the internal network.
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
import { analyseShare } from "./share";

const WEST = { lat: 48.37, lon: 10.9 };
const EAST = { lat: 48.14, lon: 11.58 };

function spot(
  n: number,
  at: { lat: number; lon: number },
  name: string,
  over: Partial<GeoPoiSearchSpot> = {},
): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: at.lat,
    lon: at.lon,
    distanceM: 100,
    detourM: null,
    name,
    nameDe: null,
    nameEn: null,
    kind: "amenity=cafe",
    categories: ["food"],
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
    ...over,
  };
}

async function seedRegion(slug: string, postgresDb: string, bbox: [number, number, number, number]) {
  await db.insert(osmRegionImports).values({
    slug,
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: postgresDb,
    bbox_min_lat: bbox[0],
    bbox_min_lon: bbox[1],
    bbox_max_lat: bbox[2],
    bbox_max_lon: bbox[3],
    status: "ready_running",
  });
}

let geo: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `share-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(user.id),
    permissions: ["photos.view"],
  });
  await seedRegion("europe/west", "nom_west", [48.2, 10.5, 48.6, 11.2]);
  await seedRegion("europe/east", "nom_east", [48.0, 11.3, 48.4, 11.9]);
  geo = new InMemoryGeoClient();
  setGeoClient(geo);
  return () => {
    resetGeoClient();
    vi.restoreAllMocks();
  };
});

async function twoLegPlan() {
  geo.setSearchSpots("nom_west", []);
  geo.setSearchSpots("nom_east", []);
  const { plan } = await createTripPlan({
    legs: [
      { title: "Weststadt", anchor: WEST },
      { title: "Oststadt", anchor: EAST },
    ],
  });
  return plan;
}

/**
 * Answer the llm-service with this, whatever it is asked. The prompt
 * itself is tested in `extract-places.test.ts`; here the model is only
 * a source of answers to validate.
 */
function stubModel(answer: unknown) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
}

const ARTICLE = [
  "Drei Orte in der Oststadt.",
  "Im Café Beispielhof gibt es den besten Kuchen der Stadt.",
  "Das Stadtmuseum Oststadt füllt einen ganzen Vormittag.",
].join("\n");

describe("POST /trip-planner/plans/:planId/shares", () => {
  describe("a shared map pin", () => {
    it("reads the coordinate and files it under the right leg", async () => {
      const plan = await twoLegPlan();
      const res = await analyseShare({
        planId: plan.id,
        url: `https://maps.apple.com/?ll=${EAST.lat},${EAST.lon}&q=Beispielhof`,
      });

      expect(res.kind).toBe("map-link");
      expect(res.proposals).toHaveLength(1);
      expect(res.proposals[0].verdict).toBe("coordinate");
      expect(res.proposals[0].position).toEqual({ lat: EAST.lat, lon: EAST.lon });
      expect(res.proposals[0].name).toBe("Beispielhof");
      // The eastern city, while the first leg is the western one.
      expect(res.proposals[0].legIndex).toBe(1);
    });

    it("leaves the leg open when the pin is in none of them", async () => {
      const plan = await twoLegPlan();
      const res = await analyseShare({
        planId: plan.id,
        url: "https://maps.apple.com/?ll=35.68,139.69&q=Weit%20weg",
      });
      // Null, not an error: the proposal is still useful and the
      // traveller picks the leg. Refusing belongs to the endpoint that
      // writes to the pool.
      expect(res.proposals[0].legIndex).toBeNull();
    });

    it("stays a pin when the share sheet adds the pin's own caption", async () => {
      // What Apple Maps hands over is the link *and* the name and
      // address as text. Reading that as an article sent the whole
      // share off to fetch a page that has no article on it, and the
      // traveller was told there was no text on the page — for a share
      // that carried a perfectly good coordinate.
      const plan = await twoLegPlan();
      const res = await analyseShare({
        planId: plan.id,
        url: `https://maps.apple.com/?ll=${EAST.lat},${EAST.lon}`,
        text: "Beispielhof\nBeispielstraße 1, 12345 Musterstadt",
      });

      expect(res.kind).toBe("map-link");
      expect(res.proposals[0].position).toEqual({ lat: EAST.lat, lon: EAST.lon });
      // The link carried no name; the caption's first line is one.
      expect(res.proposals[0].name).toBe("Beispielhof");
      expect(res.proposals[0].legIndex).toBe(1);
    });

    it("does not read a shared Google document as a pin", async () => {
      // The other half of the rule, and the reason it is safe: only a
      // real map link wins. docs.google.com ends in google.com too, and
      // a document turning into a place named after its title would be
      // a far worse bug than the one this fixes.
      const plan = await twoLegPlan();
      stubModel([]);
      const res = await analyseShare({
        planId: plan.id,
        url: "https://docs.google.com/document/d/abc/edit?q=Oststadt",
        text: ARTICLE,
      });
      expect(res.kind).toBe("article");
    });

    it("treats a link with only a search term as a page, not a pin", async () => {
      const plan = await twoLegPlan();
      stubModel([]);
      const res = await analyseShare({
        planId: plan.id,
        url: "https://beispiel.test/zehn-cafes",
        text: ARTICLE,
      });
      expect(res.kind).toBe("article");
    });
  });

  describe("a shared article", () => {
    it("resolves the names it can and keeps the quote", async () => {
      const plan = await twoLegPlan();
      geo.setSearchSpots("nom_east", [spot(1, EAST, "Café Beispielhof")]);
      stubModel([
        { name: "Café Beispielhof", quote: "gibt es den besten Kuchen der Stadt", category: "Café" },
      ]);

      const res = await analyseShare({
        planId: plan.id,
        url: "https://beispiel.test/drei-orte",
        text: ARTICLE,
      });

      expect(res.kind).toBe("article");
      expect(res.sourceUrl).toBe("https://beispiel.test/drei-orte");
      expect(res.proposals).toHaveLength(1);
      const [proposal] = res.proposals;
      expect(proposal.verdict).toBe("unique");
      expect(proposal.osmRef).toBe("node:1");
      expect(proposal.legIndex).toBe(1);
      expect(proposal.quote).toBe("gibt es den besten Kuchen der Stadt");
      expect(proposal.kindHint).toBe("Café");
    });

    it("throws away a place the page never mentioned", async () => {
      // The check the whole design turns on: an invented recommendation
      // cannot bring a quote that is really in the page.
      const plan = await twoLegPlan();
      geo.setSearchSpots("nom_east", [spot(2, EAST, "Taberna Erfunden")]);
      stubModel([
        { name: "Taberna Erfunden", quote: "die beste Taberna der Oststadt" },
      ]);

      const res = await analyseShare({ planId: plan.id, text: ARTICLE });

      expect(res.proposals).toEqual([]);
      expect(res.rejected).toHaveLength(1);
      expect(res.rejected[0]).toContain("Zitat");
    });

    it("asks which one when the name matches several", async () => {
      const plan = await twoLegPlan();
      geo.setSearchSpots("nom_east", [
        spot(3, EAST, "Café Beispielhof", { distanceM: 800 }),
        spot(4, { lat: EAST.lat + 0.01, lon: EAST.lon }, "Café Beispielhof", { distanceM: 200 }),
      ]);
      stubModel([{ name: "Café Beispielhof", quote: "gibt es den besten Kuchen der Stadt" }]);

      const [proposal] = (await analyseShare({ planId: plan.id, text: ARTICLE })).proposals;

      expect(proposal.verdict).toBe("ambiguous");
      expect(proposal.osmRef).toBeNull();
      // Nearest first, so the likelier answer is the first one offered.
      expect(proposal.options.map((o) => o.osmRef)).toEqual(["node:4", "node:3"]);
    });

    it("keeps a place OpenStreetMap does not have, as a note", async () => {
      const plan = await twoLegPlan();
      stubModel([{ name: "Café Beispielhof", quote: "gibt es den besten Kuchen der Stadt" }]);

      const [proposal] = (await analyseShare({ planId: plan.id, text: ARTICLE })).proposals;

      // Not a failure. A note with its quote, which stays in view until
      // somebody resolves it by hand (§10.4).
      expect(proposal.verdict).toBe("none");
      expect(proposal.name).toBe("Café Beispielhof");
      expect(proposal.quote).toBe("gibt es den besten Kuchen der Stadt");
    });

    it("resolves a name across legs, not only in the one on screen", async () => {
      // An article about the eastern city, read while standing in the
      // west. Searching only the current leg would find nothing.
      const plan = await twoLegPlan();
      geo.setSearchSpots("nom_east", [spot(5, EAST, "Stadtmuseum Oststadt")]);
      stubModel([{ name: "Stadtmuseum Oststadt", quote: "füllt einen ganzen Vormittag" }]);

      const [proposal] = (await analyseShare({ planId: plan.id, text: ARTICLE })).proposals;

      expect(proposal.verdict).toBe("unique");
      expect(proposal.legIndex).toBe(1);
    });

    it("strips markup when the share hands over HTML", async () => {
      const plan = await twoLegPlan();
      stubModel([{ name: "Café Beispielhof", quote: "gibt es den besten Kuchen" }]);

      const res = await analyseShare({
        planId: plan.id,
        text: `<html><script>alert(1)</script><p>Im Café Beispielhof `
          + `gibt es den besten Kuchen der Stadt.</p></html>`,
      });

      // The quote check ran against the text, not against the markup —
      // otherwise a quote spanning a tag would fail for no reason.
      expect(res.proposals).toHaveLength(1);
      expect(res.rejected).toEqual([]);
    });
  });

  describe("what it refuses", () => {
    it("needs something to work with", async () => {
      const plan = await twoLegPlan();
      await expect(analyseShare({ planId: plan.id })).rejects.toThrow(/url oder text/);
    });

    it("refuses to fetch an address in the internal network", async () => {
      // A URL-only share is the one path where the server fetches, and
      // it is the one an article could steer.
      const plan = await twoLegPlan();
      await expect(analyseShare({ planId: plan.id, url: "https://169.254.169.254/latest/" }))
        .rejects.toThrow(/interne/);
    });

    it("does not answer for a plan that is not yours", async () => {
      await expect(analyseShare({ planId: 999_999, text: ARTICLE }))
        .rejects.toThrow(/plan not found/);
    });

    it("says the model is unavailable rather than reporting an empty page", async () => {
      const plan = await twoLegPlan();
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
      await expect(analyseShare({ planId: plan.id, text: ARTICLE }))
        .rejects.toThrow(/llm-service/);
    });
  });
});
