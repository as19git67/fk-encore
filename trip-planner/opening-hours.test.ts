/**
 * Opening hours for one date (ideas plan, stage 3). 2026-09-07 is a
 * Monday.
 */

import { describe, expect, it } from "vitest";
import { closedDates, openingOn, understood, windowText } from "./opening-hours";

const MONDAY = "2026-09-07";
const TUESDAY = "2026-09-08";
const SATURDAY = "2026-09-12";
const SUNDAY = "2026-09-13";

describe("reading opening_hours", () => {
  const cases: Array<[string, string, ReturnType<typeof openingOn>]> = [
    ["24/7", MONDAY, { state: "open", windows: [{ from: 0, to: 1440 }] }],
    ["10:00-18:00", SUNDAY, { state: "open", windows: [{ from: 600, to: 1080 }] }],
    ["Tu-Su 10:00-18:00", MONDAY, { state: "closed" }],
    ["Tu-Su 10:00-18:00", TUESDAY, { state: "open", windows: [{ from: 600, to: 1080 }] }],
    ["Mo-Fr 09:00-12:00,14:00-18:00; Sa 10:00-14:00; Su off", SATURDAY,
      { state: "open", windows: [{ from: 600, to: 840 }] }],
    ["Mo-Fr 09:00-12:00,14:00-18:00; Sa 10:00-14:00; Su off", MONDAY,
      { state: "open", windows: [{ from: 540, to: 720 }, { from: 840, to: 1080 }] }],
    ["Mo-Fr 09:00-12:00,14:00-18:00; Sa 10:00-14:00; Su off", SUNDAY, { state: "closed" }],
    ["Mo-Su 10:00-18:00; Mo off", MONDAY, { state: "closed" }],
    ["Fr-Mo 18:00-02:00", SUNDAY, { state: "open", windows: [{ from: 1080, to: 1560 }] }],
    ["Fr-Mo 18:00-02:00", TUESDAY, { state: "closed" }],
    ["Jan-Mar Mo-Fr 10:00-16:00", MONDAY, { state: "unknown" }],
    ["Mo-Fr sunrise-sunset", MONDAY, { state: "unknown" }],
    ["Mo-Fr 10:00-18:00 || \"nach Vereinbarung\"", MONDAY, { state: "unknown" }],
    ["PH off", MONDAY, { state: "unknown" }],
    ["", MONDAY, { state: "unknown" }],
  ];

  it.each(cases)("%s on %s", (spec, date, expected) => {
    expect(openingOn(spec, date)).toEqual(expected);
  });

  it("closes on a holiday when the string says so", () => {
    const spec = "Mo-Sa 10:00-18:00; PH off";
    expect(openingOn(spec, MONDAY).state).toBe("open");
    expect(openingOn(spec, MONDAY, { holiday: true })).toEqual({ state: "closed" });
    expect(openingOn("Su,PH 11:00-17:00", MONDAY, { holiday: true }))
      .toEqual({ state: "open", windows: [{ from: 660, to: 1020 }] });
  });

  it("names the closed days of a stay and nothing for a string it cannot read", () => {
    expect(closedDates("Tu-Su 10:00-18:00", [SUNDAY, MONDAY, TUESDAY])).toEqual([MONDAY]);
    expect(closedDates("Apr-Oct Tu-Su 10:00-18:00", [MONDAY])).toEqual([]);
    expect(understood("Apr-Oct Tu-Su 10:00-18:00")).toBe(false);
    expect(understood("Mo-Fr 10:00-18:00")).toBe(true);
  });

  it("writes a window for a chip", () => {
    expect(windowText({ from: 600, to: 1080 })).toBe("10:00–18:00");
    expect(windowText({ from: 1080, to: 1560 })).toBe("18:00–02:00");
    expect(windowText({ from: 0, to: 1440 })).toBe("00:00–24:00");
  });
});
