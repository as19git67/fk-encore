/**
 * The frame of a journey (§22.7): which days it touches, where each
 * begins and ends, and which of them can hold a stop.
 */
import { describe, expect, it } from "vitest";
import { isJourneyEnd, transitFrame } from "./transit-leg";

const origin = { lat: 48.37, lon: 10.9, label: "Hotel am Fluss" };
const destination = { lat: 48.37, lon: 11.4, label: "Pension am See" };

describe("the frame of a journey", () => {
  it("is one plannable day from departure to arrival when it takes a day by car", () => {
    const [day, ...rest] = transitFrame({
      origin, destination, dayCount: 1, departMinutes: 600, endMinutes: 960, mode: "car",
    });
    expect(rest).toEqual([]);
    expect(day).toMatchObject({ fromMinutes: 600, toMinutes: 960, plannable: true, reason: null });
    // It starts at the origin and ends at the destination — day-ends.ts
    // reads exactly these two.
    expect(day.fixpoints.map((f) => [f.kind, f.startMinutes, f.lat, f.lon])).toEqual([
      ["appointment", 600, origin.lat, origin.lon],
      ["departure", 960, destination.lat, destination.lon],
    ]);
    expect(day.fixpoints[0].label).toBe("Abfahrt Hotel am Fluss");
    expect(day.fixpoints[1].label).toBe("Ankunft Pension am See");
  });

  it("plans nothing into a journey by train", () => {
    const [day] = transitFrame({
      origin, destination, dayCount: 1, departMinutes: 600, endMinutes: 960, mode: "transit",
    });
    expect(day.plannable).toBe(false);
    expect(day.reason).toBe("Unterwegs mit Bahn oder Bus");
  });

  it("calls the sea between two ports a day aboard", () => {
    const days = transitFrame({
      origin, destination, dayCount: 2, departMinutes: 1080, endMinutes: 480, mode: "ship",
    });
    expect(days.every((d) => !d.plannable)).toBe(true);
    expect(days.map((d) => d.reason)).toEqual(["An Bord", "An Bord"]);
  });

  it("spans several days with the departure on the first and the arrival on the last", () => {
    const days = transitFrame({
      origin, destination, dayCount: 3, departMinutes: 1200, endMinutes: 480, mode: "car",
    });
    expect(days.map((d) => [d.fromMinutes, d.toMinutes])).toEqual([[1200, 1440], [0, 1440], [0, 480]]);
    expect(days.map((d) => d.fixpoints.map((f) => f.kind))).toEqual([["appointment"], [], ["departure"]]);
    // A night on the road has no known place: nothing is planned.
    expect(days.every((d) => !d.plannable)).toBe(true);
    expect(days[0].reason).toMatch(/mehrere Tage/);
  });

  it("refuses a day's journey that arrives before it sets off", () => {
    expect(() => transitFrame({
      origin, destination, dayCount: 1, departMinutes: 960, endMinutes: 600, mode: "car",
    })).toThrow(/arrive after/);
  });
});

describe("the ends of a journey", () => {
  const leg = { kind: "transit", departMinutes: 18 * 60, endMinutes: 8 * 60, dayCount: 4 };

  it("recognises the departure on the first day and the arrival on the last", () => {
    expect(isJourneyEnd(leg, 0, { kind: "appointment", startMinutes: 18 * 60 })).toBe(true);
    expect(isJourneyEnd(leg, 3, { kind: "departure", startMinutes: 8 * 60 })).toBe(true);
  });

  it("leaves every other fixed time alone", () => {
    // The deck programme at the departure's minute on a sea day.
    expect(isJourneyEnd(leg, 1, { kind: "appointment", startMinutes: 18 * 60 })).toBe(false);
    // A dinner booked at eight on the arrival day is not the arrival.
    expect(isJourneyEnd(leg, 3, { kind: "appointment", startMinutes: 8 * 60 })).toBe(false);
    // Nothing on a stay is a journey's end.
    expect(isJourneyEnd({ ...leg, kind: "stay" }, 0, { kind: "appointment", startMinutes: 18 * 60 })).toBe(false);
  });
});
