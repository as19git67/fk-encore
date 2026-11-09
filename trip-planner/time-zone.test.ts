import { describe, expect, it } from "vitest";
import { offsetMinutes, zoneAt, zoneShiftMinutes } from "./time-zone";

describe("zoneAt", () => {
  it("finds the zone of a point offline", () => {
    expect(zoneAt({ lat: 52.52, lon: 13.4 })).toBe("Europe/Berlin");
    expect(zoneAt({ lat: 35.68, lon: 139.69 })).toBe("Asia/Tokyo");
  });

  it("gives null without a usable point", () => {
    expect(zoneAt(null)).toBeNull();
    expect(zoneAt({ lat: Number.NaN, lon: 0 })).toBeNull();
    expect(zoneAt({ lat: 95, lon: 0 })).toBeNull();
  });
});

describe("offsetMinutes", () => {
  it("follows daylight saving time", () => {
    expect(offsetMinutes("Europe/Berlin", "2027-01-15")).toBe(60);
    expect(offsetMinutes("Europe/Berlin", "2027-07-15")).toBe(120);
    expect(offsetMinutes("Asia/Kolkata", "2027-01-15")).toBe(330);
    expect(offsetMinutes("UTC", "2027-01-15")).toBe(0);
    expect(offsetMinutes("America/New_York", "2027-01-15")).toBe(-300);
  });

  it("gives null for an unknown zone", () => {
    expect(offsetMinutes("Nowhere/Nothing", "2027-01-15")).toBeNull();
  });
});

describe("zoneShiftMinutes", () => {
  it("is the jump of the clock on that day", () => {
    expect(zoneShiftMinutes("Europe/Berlin", "Asia/Tokyo", "2027-02-20")).toBe(480);
    expect(zoneShiftMinutes("Asia/Tokyo", "Europe/Berlin", "2027-07-20")).toBe(-420);
    expect(zoneShiftMinutes("Europe/Berlin", "Europe/Paris", "2027-02-20")).toBe(0);
  });

  it("asks about today without a date and gives null without a zone", () => {
    expect(zoneShiftMinutes("Europe/Berlin", "Asia/Tokyo", null, () => "2027-02-20")).toBe(480);
    expect(zoneShiftMinutes(null, "Asia/Tokyo", "2027-02-20")).toBeNull();
  });
});
