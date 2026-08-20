import { describe, expect, it } from "vitest";
import { computeConsumptionTrend } from "./trends.service";

/**
 * Monthly samples starting at `startYear`-01, `count` months long.
 * `value(index)` returns the consumption of month `index`, null for a gap.
 */
function samples(
  startYear: number,
  count: number,
  value: (index: number) => number | null,
  coverage: (index: number) => number = () => 1,
) {
  return Array.from({ length: count }, (_, index) => {
    const year = startYear + Math.floor(index / 12);
    const month = (index % 12) + 1;
    const key = `${year}-${String(month).padStart(2, "0")}`;
    return { key, label: key, value: value(index), coverage: coverage(index) };
  });
}

const trendOf = (input: ReturnType<typeof samples>) =>
  computeConsumptionTrend("test", "Test", "kWh", 0, [1], input);

describe("computeConsumptionTrend", () => {
  it("sums the last twelve months and compares them with the twelve before", () => {
    // 24 months: 100/month in the first year, 120/month in the second.
    const trend = trendOf(samples(2025, 24, (index) => (index < 12 ? 100 : 120)));

    expect(trend.current12).toBe(1440);
    expect(trend.previous12).toBe(1200);
    expect(trend.changeAbsolute).toBe(240);
    expect(trend.changePercent).toBe(0.2);
    expect(trend.direction).toBe("rising");
  });

  it("reports a falling trend when consumption goes down", () => {
    const trend = trendOf(samples(2025, 24, (index) => (index < 12 ? 120 : 100)));

    expect(trend.changeAbsolute).toBe(-240);
    expect(trend.direction).toBe("falling");
  });

  it("calls a change within the stable band stable, not a direction", () => {
    // +1% year over year — noise, not a trend.
    const trend = trendOf(samples(2025, 24, (index) => (index < 12 ? 100 : 101)));

    expect(trend.changePercent).toBe(0.01);
    expect(trend.direction).toBe("stable");
  });

  it("cancels out seasonality — a repeating season is not a trend", () => {
    // Heating-shaped season, identical every year.
    const season = [300, 260, 200, 120, 60, 20, 10, 15, 50, 130, 220, 290];
    const trend = trendOf(samples(2025, 36, (index) => season[index % 12]));

    expect(trend.changeAbsolute).toBe(0);
    expect(trend.slopePerYear).toBe(0);
    expect(trend.direction).toBe("stable");
  });

  it("derives the yearly slope from the rolling series", () => {
    // Each month 10 units higher than the same month a year earlier
    // => the annual total climbs by 120 units per year.
    const trend = trendOf(samples(2025, 36, (index) => 100 + 10 * Math.floor(index / 12)));

    expect(trend.slopePerYear).toBe(120);
    expect(trend.direction).toBe("rising");
  });

  it("keeps a drift below the stable band out of the direction", () => {
    // +1 % per year is drift, not a trend worth flagging.
    const trend = trendOf(samples(2025, 36, (index) => 100 + Math.floor(index / 12)));

    expect(trend.slopePerYear).toBe(12);
    expect(trend.direction).toBe("stable");
  });

  it("leaves the rolling sum undefined across a gap in the readings", () => {
    const trend = trendOf(samples(2025, 24, (index) => (index === 5 ? null : 100)));

    // Every window covering the missing month stays null.
    const march2026 = trend.points.find((point) => point.key === "2026-03");
    expect(march2026?.rolling12).toBeNull();
    // Once the gap has scrolled out of the window it recovers.
    expect(trend.current12).toBe(1200);
    expect(trend.previous12).toBeNull();
  });

  it("ignores months that are not fully covered by readings", () => {
    const trend = trendOf(
      samples(
        2025,
        24,
        () => 100,
        (index) => (index === 23 ? 0.4 : 1),
      ),
    );

    expect(trend.monthsAvailable).toBe(23);
    expect(trend.points.at(-1)?.key).toBe("2026-11");
  });

  it("stays unknown while there is less than a full year of data", () => {
    const trend = trendOf(samples(2025, 8, () => 100));

    expect(trend.current12).toBeNull();
    expect(trend.direction).toBe("unknown");
    expect(trend.monthsAvailable).toBe(8);
  });

  it("reports a rolling value but no comparison in the second year", () => {
    const trend = trendOf(samples(2025, 14, () => 100));

    expect(trend.current12).toBe(1200);
    expect(trend.previous12).toBeNull();
    expect(trend.changePercent).toBeNull();
    // Direction still follows from the regression over the rolling series.
    expect(trend.direction).toBe("stable");
  });

  it("exposes the period the current window covers", () => {
    const trend = trendOf(samples(2025, 24, () => 100));

    expect(trend.rangeStart).toBe("2026-01-01T00:00:00.000Z");
    expect(trend.rangeEnd).toBe("2027-01-01T00:00:00.000Z");
  });
});
