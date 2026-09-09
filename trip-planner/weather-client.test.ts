import { describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { parseClimateNormal, resetWeatherClient, setClimateClient } from "./weather-client";

const MUNICH = { lat: 48.14, lon: 11.58 };

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

describe("the climate endpoint", () => {
  it("refuses a month that is not one", async () => {
    const { climateNormal } = await import("./climate");
    vi.mocked(getAuthData).mockReturnValue({ userID: "1", permissions: ["photos.view"] });

    await expect(climateNormal({ anchor: MUNICH, month: 13 })).rejects.toThrow(/month/);
    await expect(climateNormal({ anchor: { lat: 95, lon: 0 }, month: 1 }))
      .rejects.toThrow(/coordinate/);
  });

  it("answers with the normal the client returns", async () => {
    const { climateNormal } = await import("./climate");
    vi.mocked(getAuthData).mockReturnValue({ userID: "1", permissions: ["photos.view"] });
    setClimateClient({
      async normal(_lat, _lon, month) {
        return {
          month,
          meanTemperatureC: 26.4,
          precipitationMm: 210,
          wetDays: 12,
          source: "open-meteo-climate" as const,
        };
      },
    });

    const normal = await climateNormal({ anchor: MUNICH, month: 9 });

    expect(normal.meanTemperatureC).toBe(26.4);
    expect(normal.wetDays).toBe(12);
    resetWeatherClient();
  });
});
