import { describe, expect, it } from "vitest";
import { horizonAltitude, lightWindows, solarPosition } from "./sun";

const MUNICH = { lat: 48.14, lon: 11.58 };
const TROMSO = { lat: 69.65, lon: 18.96 };
const EQUATOR = { lat: 0, lon: 0 };

describe("where the sun stands", () => {
  it("interpolates a circular terrain horizon", () => {
    expect(horizonAltitude([
      { azimuth: 0, altitude: 10 },
      { azimuth: 180, altitude: 20 },
    ], 90)).toBeCloseTo(15);
    expect(horizonAltitude([
      { azimuth: 350, altitude: 10 },
      { azimuth: 10, altitude: 20 },
    ], 0)).toBeCloseTo(15);
  });

  it("is highest at solar noon, due south, in the northern hemisphere", () => {
    // Munich on the solstice: 90 − 48.14 + 23.44 ≈ 65.3° — a figure
    // anybody can check without trusting this implementation.
    const noon = solarPosition(MUNICH, new Date("2026-06-21T11:20:00Z"));
    expect(noon.altitude).toBeCloseTo(65.3, 0);
    expect(noon.azimuth).toBeCloseTo(180, -1);
  });

  it("is at the horizon at sunrise", () => {
    // Munich rises at about 05:15 local (03:15 UTC) on the solstice.
    const rising = solarPosition(MUNICH, new Date("2026-06-21T03:20:00Z"));
    expect(Math.abs(rising.altitude)).toBeLessThan(1);
    // North-east in high summer, well left of due east.
    expect(rising.azimuth).toBeGreaterThan(40);
    expect(rising.azimuth).toBeLessThan(60);
  });

  it("stands overhead at the equator at the equinox", () => {
    const overhead = solarPosition(EQUATOR, new Date("2026-03-20T12:07:00Z"));
    expect(overhead.altitude).toBeGreaterThan(89);
  });

  it("is below the horizon at local midnight", () => {
    expect(solarPosition(MUNICH, new Date("2026-06-21T23:20:00Z")).altitude).toBeLessThan(0);
  });

  it("answers a compass bearing, never a negative one", () => {
    // Every hour of a whole year: the azimuth is a bearing, and a
    // consumer comparing it against a facade must not meet -170.
    for (let hour = 0; hour < 24 * 365; hour += 7) {
      const when = new Date(Date.UTC(2026, 0, 1) + hour * 3_600_000);
      const { azimuth } = solarPosition(MUNICH, when);
      expect(azimuth).toBeGreaterThanOrEqual(0);
      expect(azimuth).toBeLessThan(360);
    }
  });
});

describe("the windows worth planning around", () => {
  const munichSolstice = lightWindows(MUNICH, "2026-06-21", 120);

  it("puts the golden hour around sunrise and sunset, in order", () => {
    const golden = munichSolstice.filter((w) => w.kind === "golden");
    expect(golden).toHaveLength(2);
    // Local clock times: a morning window just after five, an evening
    // one ending shortly after the 21:17 sunset.
    expect(golden[0].fromMinutes).toBeGreaterThan(4 * 60);
    expect(golden[0].toMinutes).toBeLessThan(7 * 60);
    expect(golden[1].fromMinutes).toBeGreaterThan(19 * 60);
    expect(golden[1].toMinutes).toBeLessThan(22 * 60);
  });

  it("puts the blue hour outside the golden one, not inside it", () => {
    const blue = munichSolstice.filter((w) => w.kind === "blue");
    const golden = munichSolstice.filter((w) => w.kind === "golden");
    expect(blue).toHaveLength(2);
    // Morning: blue first, then golden. Evening: the other way round.
    expect(blue[0].toMinutes).toBeLessThanOrEqual(golden[0].fromMinutes);
    expect(golden[1].toMinutes).toBeLessThanOrEqual(blue[1].fromMinutes);
  });

  it("reports the harsh middle of the day as one stretch", () => {
    const harsh = munichSolstice.filter((w) => w.kind === "harsh");
    expect(harsh).toHaveLength(1);
    expect(harsh[0].fromMinutes).toBeGreaterThan(9 * 60);
    expect(harsh[0].toMinutes).toBeLessThan(17 * 60);
  });

  it("says nothing about harsh light where the sun never gets that high", () => {
    // Tromsø in midsummer has daylight around the clock and no steep
    // shadows at all. An invented noon window would be a lie in the
    // one place people go for the light (§15.3).
    const arctic = lightWindows(TROMSO, "2026-06-21", 120);
    expect(arctic.filter((w) => w.kind === "harsh")).toHaveLength(0);
    expect(arctic.filter((w) => w.kind === "blue")).toHaveLength(0);
    expect(arctic.some((w) => w.kind === "golden")).toBe(true);
  });

  it("stretches the low bands through the polar night rather than dropping them", () => {
    // Tromsø on the shortest day: the sun stays below the horizon
    // (about −3° at its highest) and crawls along it for hours, so the
    // low-sun bands are long rather than absent. That is what the place
    // actually looks like, and shortening it to an hour to match a
    // German intuition would be inventing a sunset.
    const polarNight = lightWindows(TROMSO, "2026-12-21", 60);
    expect(polarNight.filter((w) => w.kind === "harsh")).toHaveLength(0);
    expect(solarPosition(TROMSO, new Date("2026-12-21T11:00:00Z")).altitude).toBeLessThan(0);

    const golden = polarNight.filter((w) => w.kind === "golden");
    expect(golden).toHaveLength(1);
    expect(golden[0].toMinutes - golden[0].fromMinutes).toBeGreaterThan(60);
  });

  it("reads the local clock the caller names, not the server's", () => {
    // The same instant, two offsets: Tokyo's evening light is not
    // Munich's, and a coordinate does not carry its time zone.
    const utc = lightWindows(MUNICH, "2026-06-21", 0);
    const local = lightWindows(MUNICH, "2026-06-21", 120);
    const goldenUtc = utc.filter((w) => w.kind === "golden").at(-1)!;
    const goldenLocal = local.filter((w) => w.kind === "golden").at(-1)!;
    expect(goldenLocal.fromMinutes - goldenUtc.fromMinutes).toBe(120);
  });

  it("keeps the instant and the local minutes describing the same moment", () => {
    for (const window of munichSolstice) {
      const midnightUtc = Date.parse("2026-06-21T00:00:00Z") - 120 * 60_000;
      expect(Date.parse(window.from)).toBe(midnightUtc + window.fromMinutes * 60_000);
      expect(Date.parse(window.to)).toBe(midnightUtc + window.toMinutes * 60_000);
    }
  });

  it("refuses a day it cannot read rather than answering for today", () => {
    expect(() => lightWindows(MUNICH, "irgendwann")).toThrow(/calendar date/);
  });
});
