/**
 * Paperwork meeting a trip (§3.4).
 *
 * Three things decide whether this helps: that it offers travel
 * paperwork and nothing else, that it takes nothing over by itself
 * (§8.2 — "Nichts wird stillschweigend angenommen"), and that
 * attaching a document to a shared trip does not hand the document to
 * everybody on it. The last is the one that would be a real fault
 * rather than a nuisance.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import {
  documents,
  osmRegionImports,
  tripPlanDocuments,
  tripPlanShares,
  tripPlans,
  users,
} from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import {
  linkPlanDocument,
  planDocuments,
  suggestPlanDocuments,
  unlinkPlanDocument,
} from "./documents";
import { createTripPlan } from "./plans";

const LISBON = { lat: 38.72, lon: -9.14 };
const DB = "nom_pt";
/** Far enough ahead that no forecast or clock is involved. */
const START = "2026-07-12";

function spot(n: number): GeoPoiSearchSpot {
  return {
    osmRef: `way:${n}`,
    type: "way",
    id: n,
    lat: LISBON.lat + n * 0.0006,
    lon: LISBON.lon,
    distanceM: n * 70,
    detourM: null,
    name: `Ort ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=attraction",
    categories: ["sight"],
    wikidataQid: `Q${n}`,
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

let annaId = 0;
let papaId = 0;
let stamp = "";

async function makeUser(prefix: string, name: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `${prefix}-${stamp}@test.invalid`, name, password_hash: "x" })
    .returning({ id: users.id });
  return row.id;
}

function actAs(userId: number) {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(userId),
    permissions: ["photos.view"],
  });
}

/** A document in somebody's own shelf. Private, as uploads are. */
async function paper(
  over: Partial<typeof documents.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(documents)
    .values({
      user_id: over.user_id ?? annaId,
      sha256: `${stamp}-${Math.random()}`,
      original_filename: "beleg.pdf",
      mime_type: "application/pdf",
      size_bytes: 1024,
      disk_path: `/tmp/${stamp}.pdf`,
      status: "ready",
      ...over,
    })
    .returning({ id: documents.id });
  return row.id;
}

async function trip() {
  const { plan } = await createTripPlan({
    legs: [{ title: "Lissabon", anchor: LISBON, startDate: START }],
    detailDays: 0,
  });
  return plan;
}

beforeEach(async () => {
  await db.delete(tripPlanDocuments);
  await db.delete(tripPlans);
  await db.delete(documents);
  await db.delete(osmRegionImports);
  clearRouterCache();
  stamp = `${Date.now()}-${Math.random()}`;
  annaId = await makeUser("anna", "Anna");
  papaId = await makeUser("papa", "Papa");
  actAs(annaId);

  await db.insert(osmRegionImports).values({
    slug: "europe/portugal",
    geofabrik_url: "https://example.com/pt.pbf",
    postgres_db: DB,
    bbox_min_lat: 38.5,
    bbox_min_lon: -9.4,
    bbox_max_lat: 39.0,
    bbox_max_lon: -8.9,
    status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots(DB, [spot(1), spot(2), spot(3)]);
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("which papers look like they belong", () => {
  it("offers the hotel booking that names the place", async () => {
    await paper({ title: "Hotelbuchung Lissabon", summary: "Übernachtung mit Frühstück" });
    const plan = await trip();

    const { suggestions } = await suggestPlanDocuments({ planId: plan.id });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].role).toBe("lodging");
    expect(suggestions[0].reasons).toContain("nennt Lissabon");
  });

  it("offers a ticket dated inside the trip, whatever it is called", async () => {
    await paper({
      title: "Fahrkarte",
      summary: "Abfahrt 07:42",
      doc_date: START,
      original_filename: "fahrkarte.pdf",
    });
    const plan = await trip();

    const { suggestions } = await suggestPlanDocuments({ planId: plan.id });

    expect(suggestions.map((s) => s.role)).toEqual(["transport"]);
  });

  it("leaves out the phone bill from the same week", async () => {
    // Naming the date is not enough. A list that fills with everything
    // is a list nobody reads (§8.2).
    await paper({ title: "Rechnung Mobilfunk", summary: "Grundgebühr", doc_date: START });
    const plan = await trip();

    expect((await suggestPlanDocuments({ planId: plan.id })).suggestions).toEqual([]);
  });

  it("does not offer what is already attached", async () => {
    const id = await paper({ title: "Hotelbuchung Lissabon", summary: "Übernachtung" });
    const plan = await trip();
    await linkPlanDocument({ planId: plan.id, documentId: id });

    expect((await suggestPlanDocuments({ planId: plan.id })).suggestions).toEqual([]);
  });

  it("does not open somebody else's shelf", async () => {
    await paper({ title: "Hotelbuchung Lissabon", summary: "Übernachtung", user_id: papaId });
    const plan = await trip();

    expect((await suggestPlanDocuments({ planId: plan.id })).suggestions).toEqual([]);
  });

  it("takes nothing over by itself", async () => {
    await paper({ title: "Hotelbuchung Lissabon", summary: "Check-in ab 15:00" });
    const plan = await trip();

    await suggestPlanDocuments({ planId: plan.id });

    expect(await db.select().from(tripPlanDocuments)).toEqual([]);
  });
});

describe("attaching one", () => {
  it("reads the role off the document when nobody names one", async () => {
    const id = await paper({ title: "Mietwagen", summary: "Anmietung und Rückgabe" });
    const plan = await trip();

    const { document } = await linkPlanDocument({ planId: plan.id, documentId: id });

    expect(document.role).toBe("rental");
    expect(document.linkedBy).toBe("Anna");
  });

  it("hands back the hard times it reads, as hints", async () => {
    // A reading is a proposal for §4.4, not a fixpoint: OCR misreads,
    // and a departure written by machine would be a trap.
    const id = await paper({
      title: "Fahrkarte",
      summary: "Zugbindung",
      extracted_text: "Abfahrt 17:45\nAnkunft 21:03",
    });
    const plan = await trip();

    const { document } = await linkPlanDocument({ planId: plan.id, documentId: id });

    expect(document.hints.map((h) => h.label)).toEqual(["Abfahrt", "Ankunft"]);
    expect(document.hints[0].kind).toBe("departure");
  });

  it("corrects the role instead of attaching the same paper twice", async () => {
    const id = await paper({ title: "Buchung", summary: "Hotel Lissabon" });
    const plan = await trip();
    await linkPlanDocument({ planId: plan.id, documentId: id });

    const { document } = await linkPlanDocument({
      planId: plan.id, documentId: id, role: "ticket",
    });

    expect(document.role).toBe("ticket");
    expect(await db.select().from(tripPlanDocuments)).toHaveLength(1);
  });

  it("refuses a role it does not know", async () => {
    const id = await paper({ title: "Buchung" });
    const plan = await trip();

    await expect(linkPlanDocument({ planId: plan.id, documentId: id, role: "sonstiges" }))
      .rejects.toThrow(/unbekannte Rolle/);
  });

  it("refuses a document the caller may not see", async () => {
    const id = await paper({ title: "Fremde Buchung", user_id: papaId });
    const plan = await trip();

    await expect(linkPlanDocument({ planId: plan.id, documentId: id }))
      .rejects.toThrow(/document not found/);
  });

  it("takes it off again without touching the document", async () => {
    const id = await paper({ title: "Hotelbuchung Lissabon" });
    const plan = await trip();
    await linkPlanDocument({ planId: plan.id, documentId: id });

    const { removed } = await unlinkPlanDocument({ planId: plan.id, documentId: id });

    expect(removed).toBe(true);
    expect((await planDocuments({ planId: plan.id })).documents).toEqual([]);
    expect(await db.select().from(documents).where(eq(documents.id, id))).toHaveLength(1);
  });
});

describe("the trip is shared, the paperwork is not", () => {
  it("tells a fellow traveller that a document is there, not what it is", async () => {
    const id = await paper({ title: "Hotelbuchung Lissabon", extracted_text: "Check-in ab 15:00" });
    const plan = await trip();
    await linkPlanDocument({ planId: plan.id, documentId: id });
    await db.insert(tripPlanShares).values({ plan_id: plan.id, user_id: papaId });

    actAs(papaId);
    const { documents: seen } = await planDocuments({ planId: plan.id });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ readable: false, title: null, sender: null, hints: [] });
    // Who put it there is the trip's own information, and it is what
    // makes the row useful: "Anna hat das Hotel eingehängt".
    expect(seen[0].linkedBy).toBe("Anna");
    expect(seen[0].role).toBe("lodging");
  });

  it("says nothing at all to somebody who is not on the trip", async () => {
    const plan = await trip();
    actAs(papaId);

    await expect(planDocuments({ planId: plan.id })).rejects.toThrow(/plan not found/);
  });
});
