/**
 * The packing list, rule by rule (§8.6).
 *
 * The value of this list is that it is *not* generic, so what these
 * tests mostly hold onto is what it refuses to say: no rain jacket for
 * a wet day spent indoors, no tripod for a golden hour nobody planned
 * to stand in, nothing at all for a day the forecast does not reach.
 */

import { describe, expect, it } from "vitest";
import { packingList, type PackingDay } from "./packing";

function day(overrides: Partial<PackingDay> = {}): PackingDay {
  return {
    date: "2026-06-18",
    label: "Am 2026-06-18",
    outdoorStops: 2,
    categories: ["sight"],
    weather: { wetness: "dry", heat: "mild", temperatureC: 20 },
    eveningLightForPhotoStop: false,
    ...overrides,
  };
}

const ids = (days: PackingDay[], group?: { withChildren?: boolean }) =>
  packingList({ days, group }).map((item) => item.id);

describe("what to put in the bag", () => {
  it("says nothing at all about a mild dry day indoors", () => {
    expect(packingList({ days: [day({ outdoorStops: 0 })] })).toEqual([]);
  });

  it("asks for a rain jacket when the open-air day is wet", () => {
    expect(ids([day({ weather: { wetness: "wet", heat: "mild", temperatureC: 16 } })]))
      .toContain("rain-jacket");
  });

  it("does not ask for one when the wet day is spent indoors", () => {
    // A day of museums under rain needs no jacket, and saying otherwise
    // teaches people that the list is guessing.
    expect(ids([day({
      outdoorStops: 0,
      weather: { wetness: "wet", heat: "mild", temperatureC: 16 },
    })])).not.toContain("rain-jacket");
  });

  it("packs against the heat only when it is actually hot", () => {
    const hot = ids([day({ weather: { wetness: "dry", heat: "hot", temperatureC: 34 } })]);
    expect(hot).toEqual(expect.arrayContaining(["sun-hat", "water-bottle"]));

    const warm = ids([day({ weather: { wetness: "dry", heat: "warm", temperatureC: 26 } })]);
    expect(warm).not.toContain("sun-hat");
  });

  it("adds a layer when the outdoor day stays cold", () => {
    expect(ids([day({ weather: { wetness: "dry", heat: "mild", temperatureC: 7 } })]))
      .toContain("warm-layer");
  });

  it("mentions the dress code when a place of worship is in the plan", () => {
    expect(ids([day({ categories: ["sight", "worship"] })])).toContain("modest-clothing");
  });

  it("suggests a tripod only for an evening window somebody planned to stand in", () => {
    expect(ids([day({ eveningLightForPhotoStop: true })])).toContain("tripod");
    expect(ids([day({ eveningLightForPhotoStop: false })])).not.toContain("tripod");
  });

  it("packs spare clothes because somebody said there is a child along", () => {
    expect(ids([day()], { withChildren: true })).toContain("spare-clothes");
    expect(ids([day()], { withChildren: false })).not.toContain("spare-clothes");
  });

  it("says nothing weather-driven for a day no forecast reaches", () => {
    // Three weeks out there is no forecast, and a packing list that
    // invents one is worse than a short list.
    expect(ids([day({ weather: null, categories: ["sight"] })])).toEqual([]);
  });

  it("names each thing once, with the day that asked for it", () => {
    const wet = { wetness: "wet", heat: "mild", temperatureC: 15 } as const;
    const list = packingList({
      days: [
        day({ label: "Am 2026-06-18", weather: wet }),
        day({ date: "2026-06-19", label: "Am 2026-06-19", weather: wet }),
      ],
    });

    expect(list.filter((item) => item.id === "rain-jacket")).toHaveLength(1);
    // The first day that caused it, not the last: a line repeated for
    // six days is wallpaper.
    expect(list[0].reason).toContain("2026-06-18");
  });
});
