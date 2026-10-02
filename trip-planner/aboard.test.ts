/**
 * The departure a journey writes onto a port day (§21.3): "Alle an
 * Bord" with the ship's margin, or the journey on with a train's.
 */

import { describe, expect, it } from "vitest";
import { allAboardBuffer, isJourneyDeparture, journeyDeparture } from "./aboard";

const PIER = { lat: 38.71, lon: -9.13 };

describe("journeyDeparture", () => {
  it("is the journey on from a hotel, with the default margin", () => {
    const fix = journeyDeparture({ anchor: PIER, quartersAboard: false, tenderPort: false }, "Porto", "10:00", 1);
    expect(fix).toEqual({
      dayIndex: 1, at: "10:00", kind: "departure", label: "Weiterreise nach Porto",
      lat: PIER.lat, lon: PIER.lon, travelMinutes: 0,
    });
    expect(fix.bufferMinutes).toBeUndefined();
  });

  it("is 'Alle an Bord' with an hour in hand from a port day, more at a tender port", () => {
    const pier = journeyDeparture({ anchor: PIER, quartersAboard: true, tenderPort: false }, "Ponta Delgada", "17:00", 0);
    expect(pier).toMatchObject({ label: "Alle an Bord", bufferMinutes: 60, at: "17:00", kind: "departure" });
    const tender = journeyDeparture({ anchor: PIER, quartersAboard: true, tenderPort: true }, "Ponta Delgada", "17:00", 0);
    expect(tender.bufferMinutes).toBe(90);
    expect(allAboardBuffer({ tenderPort: true })).toBe(90);
  });

  it("recognises the departure it wrote, and nothing else", () => {
    expect(isJourneyDeparture({ kind: "departure", lat: PIER.lat, lon: PIER.lon }, PIER)).toBe(true);
    expect(isJourneyDeparture({ kind: "appointment", lat: PIER.lat, lon: PIER.lon }, PIER)).toBe(false);
    expect(isJourneyDeparture({ kind: "departure", lat: PIER.lat + 0.01, lon: PIER.lon }, PIER)).toBe(false);
  });
});
