import { describe, expect, it } from "vitest";
import { parseClimateNormal } from "./weather-client";

describe("climate normals", () => {
  it("aggregates daily climate values into a monthly normal", () => {
    const days = Array.from({ length: 60 }, (_, index) => `2020-01-${String((index % 30) + 1).padStart(2, "0")}`);
    const normal = parseClimateNormal({
      daily: {
        time: days,
        temperature_2m_mean: days.map(() => 10),
        precipitation_sum: days.map(() => 2),
      },
    }, 1);
    expect(normal.meanTemperatureC).toBe(10);
    expect(normal.precipitationMm).toBe(62);
    expect(normal.wetDays).toBe(31);
  });
});
