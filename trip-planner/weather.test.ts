import { describe, expect, it } from "vitest";
import {
  budgetFactor,
  heat,
  heatIndex,
  hoursWithin,
  summarise,
  wetness,
  type ForecastHour,
} from "./weather";

function hour(time: string, over: Partial<ForecastHour> = {}): ForecastHour {
  return {
    time,
    precipitationMm: 0,
    cloudCover: 0,
    temperatureC: 18,
    relativeHumidity: 60,
    ...over,
  };
}

describe("how wet a block is", () => {
  it("calls a trace of rain dry", () => {
    // A tenth of a millimetre over an afternoon is not a decision.
    expect(wetness(0)).toBe("dry");
    expect(wetness(0.1)).toBe("dry");
  });

  it("calls the drizzle that puts a hood up showers", () => {
    expect(wetness(0.2)).toBe("showers");
    expect(wetness(1.9)).toBe("showers");
  });

  it("calls real rain wet", () => {
    expect(wetness(2)).toBe("wet");
    expect(wetness(12)).toBe("wet");
  });

  it("treats a missing figure as dry rather than as rain", () => {
    // Absent data must not conjure a downpour that reshuffles a day.
    expect(wetness(Number.NaN)).toBe("dry");
  });
});

describe("how much the heat is in the way", () => {
  it("leaves cool weather alone", () => {
    // Humidity does not make 18 °C feel warmer, and the regression is
    // not defined down there.
    expect(heatIndex(18, 90)).toBe(18);
    expect(heat(18, 90)).toBe("mild");
  });

  it("adds what the humidity does to a hot afternoon", () => {
    // 33 °C at 60 % is the §7.2 example: it feels well past forty.
    const felt = heatIndex(33, 60);
    expect(felt).toBeGreaterThan(38);
    expect(heat(33, 60)).toBe("hot");
  });

  it("never makes it feel cooler than it is", () => {
    for (let t = 27; t <= 45; t += 0.5) {
      for (const humidity of [0, 20, 40, 60, 80, 100]) {
        expect(heatIndex(t, humidity)).toBeGreaterThanOrEqual(t);
      }
    }
  });

  it("calls a dry 30 °C warm rather than hot", () => {
    expect(heat(30, 25)).toBe("warm");
  });
});

describe("what the weather leaves of a block", () => {
  it("takes nothing off a dry, mild block", () => {
    expect(budgetFactor("dry", "mild")).toBe(1);
  });

  it("compounds rain and heat, because both cost time", () => {
    expect(budgetFactor("wet", "hot")).toBeLessThan(budgetFactor("wet", "mild"));
    expect(budgetFactor("wet", "hot")).toBeLessThan(budgetFactor("dry", "hot"));
  });

  it("never budgets a block down to nothing", () => {
    // A short afternoon is a plan; an empty one is a refusal dressed up
    // as weather.
    for (const wet of ["dry", "showers", "wet"] as const) {
      for (const hot of ["mild", "warm", "hot"] as const) {
        expect(budgetFactor(wet, hot)).toBeGreaterThanOrEqual(0.6);
        expect(budgetFactor(wet, hot)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("summarising the hours a block covers", () => {
  it("adds up the rain and averages the cloud", () => {
    const summary = summarise([
      hour("2026-09-07T12:00:00Z", { precipitationMm: 0.4, cloudCover: 100 }),
      hour("2026-09-07T13:00:00Z", { precipitationMm: 0.3, cloudCover: 50 }),
    ]);
    expect(summary?.precipitationMm).toBeCloseTo(0.7, 5);
    expect(summary?.cloudCover).toBe(75);
    expect(summary?.wetness).toBe("showers");
  });

  it("takes the peak temperature, not the mean", () => {
    // One hour at 34 °C is a block people remember as too hot; the
    // average would hide it behind two comfortable ones.
    const summary = summarise([
      hour("2026-09-07T12:00:00Z", { temperatureC: 24, relativeHumidity: 40 }),
      hour("2026-09-07T13:00:00Z", { temperatureC: 34, relativeHumidity: 70 }),
      hour("2026-09-07T14:00:00Z", { temperatureC: 25, relativeHumidity: 45 }),
    ]);
    expect(summary?.temperatureC).toBe(34);
    // And the humidity taken with it is the one at that hour.
    expect(summary?.relativeHumidity).toBe(70);
    expect(summary?.heat).toBe("hot");
  });

  it("says nothing rather than dry-and-mild when there are no hours", () => {
    // Beyond the forecast horizon there is no data; answering with
    // zeroes would be a forecast nobody made (§15.3).
    expect(summarise([])).toBeNull();
  });

  it("ignores a negative millimetre rather than subtracting rain", () => {
    expect(summarise([hour("2026-09-07T12:00:00Z", { precipitationMm: -3 })])
      ?.precipitationMm).toBe(0);
  });
});

describe("picking the hours a block covers", () => {
  const day = "2026-09-07";
  const hours = Array.from({ length: 24 }, (_, i) =>
    hour(`2026-09-07T${String(i).padStart(2, "0")}:00:00Z`, { temperatureC: i }));

  it("takes the hours inside the block, in the destination's clock", () => {
    // 14:00–17:00 local at UTC+2 is 12:00–15:00 UTC.
    const afternoon = hoursWithin(hours, day, 14 * 60, 17 * 60, 120);
    expect(afternoon.map((h) => h.temperatureC)).toEqual([12, 13, 14]);
  });

  it("counts an hour that begins before the block but runs into it", () => {
    // The stamp is the hour's start; 14:30 local is inside the 12:00
    // UTC hour, which the block would otherwise miss entirely.
    const short = hoursWithin(hours, day, 14 * 60 + 30, 15 * 60, 120);
    expect(short.map((h) => h.temperatureC)).toEqual([12]);
  });

  it("answers nothing for a block the forecast does not reach", () => {
    expect(hoursWithin(hours, "2026-09-30", 9 * 60, 12 * 60, 120)).toHaveLength(0);
  });
});
