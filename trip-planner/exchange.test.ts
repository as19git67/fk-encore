/**
 * A trip and an idea collection as a file and back (`exchange.ts`).
 *
 * The round trip is the contract: a file read in and written out again
 * is the same file, apart from when it was written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import {
  ideaPool,
  ideaPoolShares,
  tripPlans,
  tripPlanShares,
  tripPlanTravellers,
  users,
} from "../db/schema";
import {
  exportIdeaCollection,
  exportTrip,
  exportTripPlan,
  exportTripPlanner,
  importIdeaCollection,
  importTripPlan,
  importTripPlanner,
} from "./exchange";
import { readPlannerFile, readTripFile, type TripFile } from "./exchange-format";

let ownerId = 0;
let otherId = 0;

async function newUser(tag: string): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({ email: `exchange-${tag}-${crypto.randomUUID()}@test.invalid`, name: tag, password_hash: "x" })
    .returning({ id: users.id });
  return user.id;
}

function actAs(userId: number) {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(userId), permissions: ["photos.view"] });
}

const spot = (ref: string, lat: number, lon: number) => ({
  osmRef: ref,
  name: `Ort ${ref}`,
  localName: null,
  lat,
  lon,
  category: "museum",
  kind: "tourism=museum",
  dwellMinutes: 60,
  note: null,
  sourceUrl: null,
  wikipediaUrl: null,
  facadeAzimuth: null,
  extent: null,
});

/** Everything the format knows, filled with synthetic values. */
function sampleFile(): TripFile {
  return {
    format: "f4mil.trip",
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    trip: {
      title: "Beispielreise",
      constraints: { pace: "normal", ideas: true, voting: false, interests: ["kunst"] },
      home: { lat: 50, lon: 8, label: "Zuhause" },
      travellers: [{ label: "Kind", birthDate: "2018-05-01", shortWalks: true, getsAbout: "foot" }],
      hiddenSpots: [{ osmRef: "node:900", name: "Nicht hin" }],
      segments: [{ fromRef: "start", toRef: "node:1", mode: "bike", minutes: 12, distanceM: 3000 }],
      legs: [
        {
          title: "Musterstadt",
          kind: "stay",
          anchor: { lat: 50.1, lon: 8.1, label: "Hotel Beispiel", radiusM: null },
          origin: null,
          arriveMinutes: 900,
          departMinutes: null,
          endMinutes: null,
          mode: "foot",
          regionDb: "nom_test",
          awaitingRegion: false,
          quartersAboard: false,
          tenderPort: false,
          departureNote: "Zug 123",
          arrivalNote: null,
          startDate: "2026-06-01",
          radiusM: 5000,
          dayStartsAt: 540,
          days: [
            {
              detailed: true,
              bufferReason: null,
              anchor: null,
              breaks: [{ id: "b1", label: "Mittag", minutes: 45, blockId: "day", position: 1 }],
              excursions: [
                { id: "x1", lat: 50.3, lon: 8.3, label: "Ausflug", radiusM: 2000, departMinutes: 600, returnMinutes: 840 },
                { id: "x2", lat: 50.4, lon: 8.4, label: "Weiter", radiusM: null, departMinutes: 850, returnMinutes: 960, from: "x1" },
              ],
              fixpoints: [{
                kind: "appointment",
                label: "Führung",
                startMinutes: 660,
                durationMinutes: 60,
                travelMinutes: 0,
                bufferMinutes: 20,
                lat: 50.11,
                lon: 8.11,
                blockId: "day",
                spotRef: "node:1",
                pinReason: "ticket",
              }],
              blocks: [{
                templateId: "day",
                label: "Tag",
                kind: "explore",
                budgetMinutes: 600,
                startMinutes: 540,
                stops: [
                  {
                    ...spot("node:1", 50.11, 8.11),
                    facadeAzimuth: 45,
                    extent: { end: { lat: 50.12, lon: 8.12 }, lengthM: 1200, ascentM: 30 },
                    origin: "manual",
                    priority: "must",
                    openingHours: "Mo-Su 10:00-18:00",
                    status: "done",
                    pinned: true,
                    doneAt: "2026-06-01T10:15:00.000Z",
                    placedBy: "hand",
                    travelMinutes: 10,
                    travelDistanceM: 800,
                    reasons: ["bekannt"],
                  },
                  {
                    ...spot("node:2", 50.13, 8.13),
                    origin: "search",
                    priority: "maybe",
                    openingHours: null,
                    status: "planned",
                    pinned: false,
                    doneAt: null,
                    placedBy: "fill",
                    travelMinutes: 5,
                    travelDistanceM: 400,
                    reasons: [],
                  },
                ],
              }],
            },
            {
              detailed: false,
              bufferReason: "Regentag",
              anchor: {
                lat: 50.2, lon: 8.2, label: "Nachbarort", radiusM: 3000,
                departMinutes: 540, returnMinutes: 1080, waterDetourM: null, waterAround: null,
              },
              breaks: [],
              excursions: [],
              fixpoints: [],
              blocks: [],
            },
          ],
          pool: [{
            ...spot("node:3", 50.14, 8.14),
            origin: "manual",
            priority: "want",
            openingHours: null,
            score: 10.5,
            priorityBoost: 0,
            unmatched: false,
            reasons: ["von Hand"],
            searchScore: null,
          }],
          spotNotes: [{ osmRef: "node:1", title: "Unser Museum", note: "früh hin", url: null, dwellMinutes: 90, photoStop: true }],
          dismissedDayTrips: [{ targetKey: "relation:77", name: "Fernort" }],
        },
        {
          title: null,
          kind: "transit",
          anchor: { lat: 51, lon: 9, label: null, radiusM: null },
          origin: { lat: 50.1, lon: 8.1, label: "Hotel Beispiel" },
          arriveMinutes: null,
          departMinutes: 600,
          endMinutes: 840,
          mode: "car",
          regionDb: "nom_test",
          awaitingRegion: false,
          quartersAboard: false,
          tenderPort: false,
          departureNote: null,
          arrivalNote: null,
          startDate: "2026-06-03",
          radiusM: null,
          dayStartsAt: null,
          days: [{ detailed: true, bufferReason: null, anchor: null, breaks: [], excursions: [], fixpoints: [], blocks: [] }],
          pool: [],
          spotNotes: [],
          dismissedDayTrips: [],
        },
      ],
    },
  };
}

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(ideaPoolShares);
  await db.delete(ideaPool);
  ownerId = await newUser("owner");
  otherId = await newUser("other");
  actAs(ownerId);
});

describe("a trip as a file", () => {
  it("comes back exactly as it went in", async () => {
    const file = sampleFile();
    const { planId } = await importTripPlan({ data: file as unknown as Record<string, unknown> });

    const out = await exportTripPlan({ planId });
    expect(out.format).toBe("f4mil.trip");
    expect(out.version).toBe(1);
    expect(out.trip).toEqual(readTripFile(file).trip);

    // And a second generation is the same as the first.
    const again = await importTripPlan({ data: out as unknown as Record<string, unknown> });
    expect(again.planId).not.toBe(planId);
    expect((await exportTripPlan({ planId: again.planId })).trip).toEqual(out.trip);
  });

  it("belongs to whoever imports it and may be renamed on the way in", async () => {
    actAs(otherId);
    const { planId, title } = await importTripPlan({
      data: sampleFile() as unknown as Record<string, unknown>,
      title: "Kopie",
    });
    expect(title).toBe("Kopie");
    const [row] = await db.select().from(tripPlans).where(eq(tripPlans.id, planId));
    expect(row.owner_id).toBe(otherId);
  });

  it("leaves accounts out: shares and account travellers stay behind", async () => {
    const { planId } = await importTripPlan({ data: sampleFile() as unknown as Record<string, unknown> });
    await db.insert(tripPlanShares).values({ plan_id: planId, user_id: otherId });
    await db.insert(tripPlanTravellers).values({ plan_id: planId, label: "other", added_for_user_id: otherId });

    const file = await exportTrip(planId);
    expect(file?.trip.travellers.map((t) => t.label)).toEqual(["Kind"]);
  });

  it("may be exported by a companion, not by a stranger", async () => {
    const { planId } = await importTripPlan({ data: sampleFile() as unknown as Record<string, unknown> });
    actAs(otherId);
    await expect(exportTripPlan({ planId })).rejects.toThrow("plan not found");
    await db.insert(tripPlanShares).values({ plan_id: planId, user_id: otherId });
    expect((await exportTripPlan({ planId })).trip.title).toBe("Beispielreise");
  });

  it("refuses a broken file and says where it is broken", async () => {
    const file = sampleFile() as unknown as { trip: { legs: Array<{ days: Array<{ blocks: Array<{ stops: Array<{ lat: unknown }> }> }> }> } };
    file.trip.legs[0].days[0].blocks[0].stops[1].lat = "nördlich";
    await expect(importTripPlan({ data: file as unknown as Record<string, unknown> }))
      .rejects.toThrow("reise.legs[0].days[0].blocks[0].stops[1].lat: Zahl erwartet");
    expect(await db.select().from(tripPlans)).toHaveLength(0);
  });
});

describe("reading a trip file", () => {
  it("refuses a newer version instead of guessing", () => {
    expect(() => readTripFile({ ...sampleFile(), version: 2 })).toThrow("Version 2");
  });

  it("tells an ideas file from a trip file", () => {
    expect(() => readTripFile({ format: "f4mil.ideas", version: 1, ideas: [] })).toThrow("enthält Ideen");
  });

  it("refuses something that is no export at all", () => {
    expect(() => readTripFile({ hello: "world" })).toThrow("format");
    expect(() => readTripFile([1, 2])).toThrow("Objekt erwartet");
  });

  it("names unknown values of a closed list", () => {
    const file = sampleFile();
    (file.trip.legs[0] as { mode: string }).mode = "rocket";
    expect(() => readTripFile(file)).toThrow("reise.legs[0].mode");
  });

  it("refuses a chained excursion whose start is not on the day", () => {
    const file = sampleFile();
    file.trip.legs[0].days[0].excursions[1].from = "x9";
    expect(() => readTripFile(file)).toThrow("kein Ausflug „x9“");
  });

  it("fills what an older or hand-written file leaves out", () => {
    const file = sampleFile() as unknown as { trip: { legs: Array<Record<string, unknown>> } };
    delete file.trip.legs[1].pool;
    delete file.trip.legs[1].spotNotes;
    delete file.trip.legs[1].dismissedDayTrips;
    const read = readTripFile(file);
    expect(read.trip.legs[1].pool).toEqual([]);
  });
});

describe("ideas as a file", () => {
  async function seedIdeas() {
    await db.insert(ideaPool).values([
      { owner_id: ownerId, created_by: ownerId, osm_ref: "node:10", name: "Biergarten am Beispielweg",
        lat: 50.5, lon: 8.5, category: "food", dwell_minutes: 90, note: "laut Nachbarn gut" },
      { owner_id: ownerId, created_by: ownerId, osm_ref: "manual:abc", name: null, title: "Unser Aussichtspunkt",
        lat: 50.6, lon: 8.6, category: "viewpoint", dwell_minutes: 30, unmatched: true,
        valid_from: "2026-07-01", valid_to: "2026-07-31" },
    ]);
  }

  it("moves a collection to somebody else's", async () => {
    await seedIdeas();
    const file = await exportIdeaCollection({});
    expect(file.format).toBe("f4mil.ideas");
    expect(file.ideas.map((i) => i.osmRef)).toEqual(["node:10", "manual:abc"]);

    actAs(otherId);
    const result = await importIdeaCollection({ data: file as unknown as Record<string, unknown> });
    expect(result).toEqual({ added: 2, skipped: 0 });
    const mine = await exportIdeaCollection({});
    expect(mine.ideas).toEqual(file.ideas);
  });

  it("adds nothing the collection already has", async () => {
    await seedIdeas();
    const file = await exportIdeaCollection({});
    expect(await importIdeaCollection({ data: file as unknown as Record<string, unknown> }))
      .toEqual({ added: 0, skipped: 2 });
    expect(await db.select().from(ideaPool)).toHaveLength(2);
  });

  it("writes only into a collection the caller may write into", async () => {
    await seedIdeas();
    const file = await exportIdeaCollection({});
    actAs(otherId);
    await expect(importIdeaCollection({ data: file as unknown as Record<string, unknown>, ownerId }))
      .rejects.toThrow();
    await expect(exportIdeaCollection({ ownerId })).rejects.toThrow();
  });

  it("refuses a trip file", async () => {
    await expect(importIdeaCollection({ data: sampleFile() as unknown as Record<string, unknown> }))
      .rejects.toThrow("enthält eine Reise");
  });
});

describe("everything of the planner as one file", () => {
  async function seed() {
    const first = await importTripPlan({ data: sampleFile() as unknown as Record<string, unknown> });
    const second = await importTripPlan({
      data: sampleFile() as unknown as Record<string, unknown>,
      title: "Zweite Reise",
    });
    await db.insert(ideaPool).values({
      owner_id: ownerId, created_by: ownerId, osm_ref: "node:10", name: "Biergarten am Beispielweg",
      lat: 50.5, lon: 8.5, category: "food", dwell_minutes: 90,
    });
    return [first.planId, second.planId];
  }

  it("holds every trip and the ideas, and comes back as it went", async () => {
    await seed();
    const file = await exportTripPlanner();
    expect(file.format).toBe("f4mil.tripplanner");
    expect(file.trips.map((t) => t.title)).toEqual(["Beispielreise", "Zweite Reise"]);
    expect(file.ideas.map((i) => i.osmRef)).toEqual(["node:10"]);

    actAs(otherId);
    const result = await importTripPlanner({ data: file as unknown as Record<string, unknown> });
    expect(result.trips.map((t) => t.title)).toEqual(["Beispielreise", "Zweite Reise"]);
    expect(result.ideas).toEqual({ added: 1, skipped: 0 });

    const back = await exportTripPlanner();
    expect(back.trips).toEqual(readPlannerFile(file).trips);
    expect(back.ideas).toEqual(file.ideas);
  });

  it("takes the trips shared with the caller along, not strangers' trips", async () => {
    const [shared] = await seed();
    actAs(otherId);
    expect((await exportTripPlanner()).trips).toHaveLength(0);
    await db.insert(tripPlanShares).values({ plan_id: shared, user_id: otherId });
    expect((await exportTripPlanner()).trips).toHaveLength(1);
  });

  it("writes nothing when one trip in the file is broken", async () => {
    await seed();
    const file = await exportTripPlanner() as unknown as { trips: Array<{ legs: Array<{ mode: string }> }> };
    file.trips[1].legs[0].mode = "rocket";
    await db.delete(tripPlans);
    await expect(importTripPlanner({ data: file as unknown as Record<string, unknown> }))
      .rejects.toThrow("reisen[1].legs[0].mode");
    expect(await db.select().from(tripPlans)).toHaveLength(0);
  });

  it("is not a single trip file", async () => {
    await expect(importTripPlanner({ data: sampleFile() as unknown as Record<string, unknown> }))
      .rejects.toThrow("enthält eine Reise");
    expect(() => readTripFile({ format: "f4mil.tripplanner", version: 1, trips: [] }))
      .toThrow("alle Reisen und Ideen");
  });
});
