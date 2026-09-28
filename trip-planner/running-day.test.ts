/**
 * Which leg is being lived, by date and time (§22.7): one calendar day
 * can hold the morning of one leg, a journey, and the evening of the
 * next.
 */
import { describe, expect, it } from "vitest";
import { runningDayAt, windowOf, type RunningLeg } from "./running-day";

const D = "2026-09-06";

const stayBefore: RunningLeg = {
  position: 0, kind: "stay", startDate: "2026-09-05", arriveMinutes: null,
  days: [
    { dayIndex: 0, fixpoints: [] },
    { dayIndex: 1, fixpoints: [{ kind: "departure", startMinutes: 600 }] },
  ],
};
const journey: RunningLeg = {
  position: 1, kind: "transit", startDate: D, arriveMinutes: null, departMinutes: 600,
  days: [{ dayIndex: 0, fixpoints: [
    { kind: "appointment", startMinutes: 600 },
    { kind: "departure", startMinutes: 960 },
  ] }],
};
const stayAfter: RunningLeg = {
  position: 2, kind: "stay", startDate: D, arriveMinutes: 960,
  days: [{ dayIndex: 0, fixpoints: [] }, { dayIndex: 1, fixpoints: [] }],
};
const legs = [stayAfter, journey, stayBefore];

describe("the day being lived", () => {
  it("is the morning of the leg being left, before the departure", () => {
    expect(runningDayAt(legs, D, 540)?.leg.position).toBe(0);
  });

  it("is the journey between departure and arrival", () => {
    expect(runningDayAt(legs, D, 600)?.leg.position).toBe(1);
    expect(runningDayAt(legs, D, 959)?.leg.position).toBe(1);
  });

  it("is the leg arrived at, from the arrival on", () => {
    expect(runningDayAt(legs, D, 960)?.leg.position).toBe(2);
    expect(runningDayAt(legs, D, 1400)?.day.dayIndex).toBe(0);
  });

  it("is a plain date's only day where nothing overlaps", () => {
    expect(runningDayAt(legs, "2026-09-05", 300)?.leg.position).toBe(0);
    expect(runningDayAt(legs, "2026-09-07", 300)?.day.dayIndex).toBe(1);
    expect(runningDayAt(legs, "2026-09-20", 300)).toBeNull();
  });

  it("stays with the leg that opened last when the plan knows no journey", () => {
    // A departure at 10:00 and an arrival at 16:00 with nothing between:
    // at noon the group has left, and the leg it left is still the
    // last thing the plan can say.
    const noJourney = [stayBefore, stayAfter];
    expect(runningDayAt(noJourney, D, 720)?.leg.position).toBe(0);
    expect(runningDayAt(noJourney, D, 1000)?.leg.position).toBe(2);
  });

  it("reads each day's window", () => {
    expect(windowOf(stayBefore, stayBefore.days[1])).toEqual({ from: 0, to: 600 });
    expect(windowOf(journey, journey.days[0])).toEqual({ from: 600, to: 960 });
    expect(windowOf(stayAfter, stayAfter.days[0])).toEqual({ from: 960, to: 1440 });
    expect(windowOf(stayAfter, stayAfter.days[1])).toEqual({ from: 0, to: 1440 });
  });
});
