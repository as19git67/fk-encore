/**
 * Fetching the forecast, and mostly not fetching it (§7.2).
 *
 * Every case here is about restraint: one request per place per day,
 * one request for a whole span rather than one per day, nothing at all
 * beyond the horizon, and a service that is down costing a plan
 * nothing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import db from "../db/database";
import { weatherForecastCache } from "../db/schema";
import type { ForecastHour } from "./weather";
import {
  resetWeatherClient,
  roundToGrid,
  setWeatherClient,
  WeatherUnavailableError,
  type Forecast,
  type WeatherClient,
} from "./weather-client";
import { forecastFor } from "./weather-service";
import { forgetForecastsBefore, readForecast, writeForecast } from "./weather-store";

const MUNICH = { lat: 48.137154, lon: 11.576124 };

function hoursFor(day: string, temperature = 20): ForecastHour[] {
  return Array.from({ length: 24 }, (_, i) => ({
    time: `${day}T${String(i).padStart(2, "0")}:00:00Z`,
    precipitationMm: 0,
    cloudCover: 10,
    temperatureC: temperature,
    relativeHumidity: 50,
  }));
}

/** Counts what it was asked, and never leaves the house. */
class StubClient implements WeatherClient {
  calls: { lat: number; lon: number; from: string; to: string }[] = [];
  fail: Error | null = null;
  temperature = 20;

  async forecast(lat: number, lon: number, from: string, to: string): Promise<Forecast> {
    this.calls.push({ lat, lon, from, to });
    if (this.fail) throw this.fail;
    const hours: ForecastHour[] = [];
    for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`);
         day = new Date(day.getTime() + 86_400_000)) {
      hours.push(...hoursFor(day.toISOString().slice(0, 10), this.temperature));
    }
    return { lat, lon, hours };
  }
}

let client: StubClient;
const NOW = new Date("2026-09-07T09:00:00Z");
const TODAY = "2026-09-07";

beforeEach(async () => {
  await db.delete(weatherForecastCache);
  client = new StubClient();
  setWeatherClient(client);
  return () => resetWeatherClient();
});

describe("asking for a forecast", () => {
  it("rounds the coordinate before anything leaves the house", async () => {
    // §7.2: a coordinate rounded to about five kilometres, and a date.
    // Enough for a city forecast, useless as a movement profile.
    await forecastFor(MUNICH, [TODAY], NOW);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].lat).toBe(roundToGrid(MUNICH.lat));
    expect(client.calls[0].lat).not.toBe(MUNICH.lat);
    // And no floating-point dust, or the cache key would differ per caller.
    expect(String(client.calls[0].lat)).toBe("48.15");
  });

  it("asks once and serves the rest from the cache", async () => {
    await forecastFor(MUNICH, [TODAY], NOW);
    const again = await forecastFor(MUNICH, [TODAY], NOW);

    expect(client.calls).toHaveLength(1);
    expect(again.byDay.get(TODAY)).toHaveLength(24);
    expect(again.degraded).toBe(false);
  });

  it("asks once for a whole span, not once per day", async () => {
    // A fortnight in Japan is one request, not fourteen.
    const days = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"];
    const answer = await forecastFor(MUNICH, days, NOW);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].from).toBe("2026-09-07");
    expect(client.calls[0].to).toBe("2026-09-11");
    expect([...answer.byDay.keys()]).toEqual(days);
  });

  it("re-asks for today sooner than for the rest of the week", async () => {
    // The day you are standing in is the one that changes.
    await forecastFor(MUNICH, [TODAY, "2026-09-10"], NOW);
    expect(client.calls).toHaveLength(1);

    const twoHoursLater = new Date(NOW.getTime() + 2 * 3_600_000);
    await forecastFor(MUNICH, [TODAY, "2026-09-10"], twoHoursLater);

    // Today has gone stale; the later day has not.
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1].from).toBe(TODAY);
    expect(client.calls[1].to).toBe(TODAY);
  });

  it("says nothing about a day beyond the forecast horizon", async () => {
    // §7.2 wants climate normals out there, which is a different
    // question. An invented average would be worse than silence.
    const answer = await forecastFor(MUNICH, ["2027-06-01"], NOW);

    expect(client.calls).toHaveLength(0);
    expect(answer.byDay.size).toBe(0);
    expect(answer.degraded).toBe(false);
  });

  it("says nothing about a day that has passed", async () => {
    const answer = await forecastFor(MUNICH, ["2026-09-01"], NOW);
    expect(client.calls).toHaveLength(0);
    expect(answer.byDay.size).toBe(0);
  });

  it("carries on without weather when the service is down", async () => {
    // A plan is still a plan in the rain. One that refuses to open
    // because a third party is unreachable is not.
    client.fail = new WeatherUnavailableError("open-meteo answered 503");

    const answer = await forecastFor(MUNICH, [TODAY], NOW);

    expect(answer.byDay.size).toBe(0);
    expect(answer.degraded).toBe(true);
  });

  it("falls back to a stale forecast rather than to none", async () => {
    await forecastFor(MUNICH, [TODAY], NOW);
    client.fail = new WeatherUnavailableError("open-meteo answered 503");

    const muchLater = new Date(NOW.getTime() + 12 * 3_600_000);
    const answer = await forecastFor(MUNICH, [TODAY], muchLater);

    // Yesterday's opinion about today beats no opinion at all, and the
    // caller is told it is second-hand.
    expect(answer.byDay.get(TODAY)).toHaveLength(24);
    expect(answer.degraded).toBe(true);
  });

  it("keeps the newer forecast when it asks again", async () => {
    await forecastFor(MUNICH, [TODAY], NOW);
    client.temperature = 31;

    const twoHoursLater = new Date(NOW.getTime() + 2 * 3_600_000);
    const answer = await forecastFor(MUNICH, [TODAY], twoHoursLater);

    expect(answer.byDay.get(TODAY)?.[0].temperatureC).toBe(31);
  });

  it("ignores a day that is not a date", async () => {
    const answer = await forecastFor(MUNICH, ["irgendwann", TODAY], NOW);
    expect(answer.byDay.size).toBe(1);
  });
});

describe("the cache itself", () => {
  it("keys on the rounded place and the day", async () => {
    await writeForecast(48.15, 11.6, new Map([[TODAY, hoursFor(TODAY)]]));

    expect((await readForecast(48.15, 11.6, [TODAY])).size).toBe(1);
    // A different city is a different question.
    expect((await readForecast(52.5, 13.4, [TODAY])).size).toBe(0);
  });

  it("forgets forecasts for days that have passed", async () => {
    await writeForecast(48.15, 11.6, new Map([
      ["2026-09-01", hoursFor("2026-09-01")],
      [TODAY, hoursFor(TODAY)],
    ]));

    expect(await forgetForecastsBefore(TODAY)).toBe(1);
    expect((await readForecast(48.15, 11.6, ["2026-09-01", TODAY])).size).toBe(1);
  });
});
