/**
 * Letting a planned trip name the memory it produced (§8.7).
 *
 * A trip recap normally derives its title from the photographs. When
 * the same days were planned in the app, somebody already chose a name
 * for them, and these cases pin down that this one wins — and, just as
 * importantly, that a plan reaches no further than the name.
 */

import { beforeEach, describe, expect, it } from "vitest";
import db from "../db/database";
import { tripPlanDays, tripPlanLegs, tripPlans, users } from "../db/schema";
import { loadPlannedTrips, plannedTitle, tripFor, type PlannedTrip } from "./recaps.planned-trips";

const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

let ownerId = 0;

async function makeUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `recap-plan-${Date.now()}-${Math.random()}@test.invalid`,
      name: "Reisende",
      password_hash: "x",
    })
    .returning({ id: users.id });
  return row.id;
}

/** A plan with one leg per entry, each starting on its own date. */
async function plan(
  title: string | null,
  legs: { title: string | null; startDate: string; days: number }[],
): Promise<number> {
  const [row] = await db
    .insert(tripPlans)
    .values({ owner_id: ownerId, title, constraints: {} })
    .returning({ id: tripPlans.id });
  let position = 0;
  for (const leg of legs) {
    const [legRow] = await db
      .insert(tripPlanLegs)
      .values({
        plan_id: row.id,
        position,
        title: leg.title,
        anchor_lat: 48.14,
        anchor_lon: 11.58,
        mode: "foot",
        region_db: "nom_west",
        start_date: leg.startDate,
      })
      .returning({ id: tripPlanLegs.id });
    for (let index = 0; index < leg.days; index += 1) {
      await db.insert(tripPlanDays).values({ leg_id: legRow.id, day_index: index });
    }
    position += 1;
  }
  return row.id;
}

beforeEach(async () => {
  await db.delete(tripPlans);
  ownerId = await makeUser();
});

describe("what the planner knows about a trip", () => {
  it("spans a trip from its first leg to the end of its last", async () => {
    const planId = await plan("Zwei Städte", [
      { title: "Beispielstadt", startDate: "2026-06-18", days: 3 },
      { title: "Musterstadt", startDate: "2026-06-21", days: 2 },
    ]);

    const [trip] = await loadPlannedTrips(ownerId);

    expect(trip.planId).toBe(planId);
    expect(trip.start.toISOString().slice(0, 10)).toBe("2026-06-18");
    // Three days from the 18th end on the 20th; two from the 21st on
    // the 22nd.
    expect(trip.end.toISOString().slice(0, 10)).toBe("2026-06-22");
    expect(trip.legTitles).toEqual(["Beispielstadt", "Musterstadt"]);
  });

  it("ignores a trip nobody has placed in the year", async () => {
    const [row] = await db
      .insert(tripPlans)
      .values({ owner_id: ownerId, title: "Irgendwann", constraints: {} })
      .returning({ id: tripPlans.id });
    await db.insert(tripPlanLegs).values({
      plan_id: row.id,
      position: 0,
      title: "Irgendwo",
      anchor_lat: 48.14,
      anchor_lon: 11.58,
      mode: "foot",
      region_db: "nom_west",
    });

    expect(await loadPlannedTrips(ownerId)).toEqual([]);
  });
});

describe("matching a photo cluster to a plan", () => {
  const trip = (start: string, end: string, title: string | null = "Reise"): PlannedTrip => ({
    planId: 1,
    title,
    legTitles: [],
    start: day(start),
    end: day(end),
  });

  it("takes the plan the photos fall inside", () => {
    const match = tripFor({ start: day("2026-06-19"), end: day("2026-06-20") },
                          [trip("2026-06-18", "2026-06-22")]);
    expect(match).not.toBeNull();
  });

  it("allows a day either side", () => {
    // People photograph the drive there and the morning after they get
    // back; a window that stopped at the plan's edges would cut both.
    expect(tripFor({ start: day("2026-06-17"), end: day("2026-06-19") },
                   [trip("2026-06-18", "2026-06-22")])).not.toBeNull();
    expect(tripFor({ start: day("2026-06-22"), end: day("2026-06-23") },
                   [trip("2026-06-18", "2026-06-22")])).not.toBeNull();
  });

  it("leaves a cluster from another week alone", () => {
    expect(tripFor({ start: day("2026-08-01"), end: day("2026-08-03") },
                   [trip("2026-06-18", "2026-06-22")])).toBeNull();
  });

  it("prefers the longer plan when two cover the same days", () => {
    const short = { ...trip("2026-06-19", "2026-06-19", "Kurz"), planId: 2 };
    const long = { ...trip("2026-06-18", "2026-06-25", "Lang"), planId: 3 };
    const match = tripFor({ start: day("2026-06-19"), end: day("2026-06-19") }, [short, long]);
    expect(match?.planId).toBe(3);
  });
});

describe("what to call it", () => {
  const base: PlannedTrip = {
    planId: 1,
    title: null,
    legTitles: [],
    start: day("2026-06-18"),
    end: day("2026-06-22"),
  };

  it("uses the name somebody typed", () => {
    expect(plannedTitle({ ...base, title: "  Drei Wochen Japan  " }))
      .toBe("Drei Wochen Japan");
  });

  it("falls back to the cities, which say more than one of them", () => {
    expect(plannedTitle({ ...base, legTitles: ["Tokio", "Kyoto", "Osaka"] }))
      .toBe("Tokio · Kyoto · Osaka");
  });

  it("does not run a long trip's whole itinerary into the title", () => {
    expect(plannedTitle({ ...base, legTitles: ["A", "B", "C", "D", "E"] }))
      .toBe("A · B · C +2");
  });

  it("says nothing when the plan has nothing to add", () => {
    // Then the photo-derived title stays, which is the right answer
    // rather than an empty heading.
    expect(plannedTitle(base)).toBeNull();
  });
});
