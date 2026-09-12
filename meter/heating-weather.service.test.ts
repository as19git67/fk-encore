import { describe, expect, it } from "vitest";
import { buildHeatingWeatherReport } from "./heating-weather.service";
import type { MeterReportBucket } from "./reports.service";

function month(key: string, consumption: number, coverage = 1): MeterReportBucket {
  const [year, m] = key.split("-").map(Number);
  return {
    key,
    label: `${String(m).padStart(2, "0")}.${year}`,
    periodStart: `${key}-01T00:00:00.000Z`,
    periodEnd: new Date(Date.UTC(year, m, 1)).toISOString(),
    startReadingAt: `${key}-01T00:00:00.000Z`,
    endReadingAt: new Date(Date.UTC(year, m, 1)).toISOString(),
    startValue: 0,
    endValue: consumption,
    consumption,
    intervals: 1,
    coverage,
    meanIntervalDays: 30,
    previousConsumption: null,
    deltaAbsolute: null,
    deltaPercent: null,
  };
}

const meter = { id: 7, name: "Heizung", unit: "kWh" };

/** Twelve months of a year with a winter-heavy profile scaled by `factor`. */
function fullYear(year: number, factor: number): MeterReportBucket[] {
  const profile = [500, 450, 350, 200, 80, 20, 10, 10, 60, 200, 350, 480];
  return profile.map((value, index) =>
    month(`${year}-${String(index + 1).padStart(2, "0")}`, value * factor),
  );
}

function degreeDays(year: number, factor: number): Array<[string, number]> {
  const profile = [600, 520, 420, 250, 100, 20, 5, 5, 80, 250, 430, 580];
  return profile.map((value, index) => [
    `${year}-${String(index + 1).padStart(2, "0")}`,
    value * factor,
  ]);
}

describe("buildHeatingWeatherReport — degree_days mode", () => {
  it("normalises a colder winter back to a normal one", () => {
    // 2026 was 20 % colder than 2025 and the house used 20 % more — the
    // adjusted figure should say: nothing changed.
    const buckets = [...fullYear(2025, 1), ...fullYear(2026, 1.2)];
    const dd = new Map([...degreeDays(2025, 1), ...degreeDays(2026, 1.2)]);

    const report = buildHeatingWeatherReport(meter, buckets, dd);

    expect(report.source).toBe("degree_days");
    expect(report.degreeDayMonths).toBe(24);
    // Normal January = mean(600, 720) = 660 Kd.
    expect(report.normalDegreeDays[0]).toBe(660);

    const jan25 = report.buckets.find((b) => b.key === "2025-01")!;
    const jan26 = report.buckets.find((b) => b.key === "2026-01")!;
    expect(jan25.kwhPerDegreeDay).toBeCloseTo(500 / 600, 3);
    expect(jan26.kwhPerDegreeDay).toBeCloseTo(600 / 720, 3);
    // Same efficiency → same adjusted consumption.
    expect(jan25.adjustedKwh).toBe(jan26.adjustedKwh);
    expect(jan26.deviationPercent).toBe(0);

    expect(report.years.map((y) => y.kwhPerDegreeDay)).toEqual([
      report.years[0].kwhPerDegreeDay,
      report.years[0].kwhPerDegreeDay,
    ]);
    expect(report.changePercent).toBe(0);
    expect(report.latestKwhPerDegreeDay).toBeCloseTo(2710 / 3260, 3);
  });

  it("flags a house that really uses more per degree day", () => {
    const buckets = [...fullYear(2025, 1), ...fullYear(2026, 1.2)];
    // Same weather both years → the extra 20 % is real.
    const dd = new Map([...degreeDays(2025, 1), ...degreeDays(2026, 1)]);

    const report = buildHeatingWeatherReport(meter, buckets, dd);

    expect(report.changePercent).toBe(0.2);
    const jan26 = report.buckets.find((b) => b.key === "2026-01")!;
    // Typical January (adjusted) = mean(500, 600) = 550; 600 is +9.1 %.
    expect(jan26.typicalKwh).toBe(550);
    expect(jan26.deviationPercent).toBe(0.091);
  });

  it("leaves months without a degree-day row unadjusted", () => {
    const buckets = [month("2026-01", 500), month("2026-02", 450)];
    const dd = new Map([["2026-01", 600]]);
    const report = buildHeatingWeatherReport(meter, buckets, dd);
    expect(report.source).toBe("degree_days");
    expect(report.degreeDayMonths).toBe(1);
    const feb = report.buckets.find((b) => b.key === "2026-02")!;
    expect(feb.degreeDays).toBeNull();
    expect(feb.kwhPerDegreeDay).toBeNull();
    expect(feb.adjustedKwh).toBeNull();
    // A year with a gap has no yearly kWh/Kd.
    expect(report.years[0].kwhPerDegreeDay).toBeNull();
  });
});

describe("buildHeatingWeatherReport — estimated mode", () => {
  it("compares each month against the household's own typical month", () => {
    const buckets = [...fullYear(2024, 1), ...fullYear(2025, 1), ...fullYear(2026, 1.5)];
    const report = buildHeatingWeatherReport(meter, buckets, new Map());

    expect(report.source).toBe("estimated");
    expect(report.referenceYears).toBe(3);
    expect(report.normalDegreeDays.every((value) => value === null)).toBe(true);
    // Typical January = mean(500, 500, 750) = 583.3.
    expect(report.typicalKwh[0]).toBe(583.3);
    const jan26 = report.buckets.find((b) => b.key === "2026-01")!;
    expect(jan26.adjustedKwh).toBeNull();
    expect(jan26.deviationPercent).toBe(0.286);
    // No degree days → no kWh/Kd figures at all.
    expect(report.latestKwhPerDegreeDay).toBeNull();
    expect(report.years.every((y) => y.kwhPerDegreeDay === null)).toBe(true);
  });

  it("needs two years before a month has a typical value", () => {
    const report = buildHeatingWeatherReport(meter, fullYear(2026, 1), new Map());
    expect(report.typicalKwh.every((value) => value === null)).toBe(true);
    expect(report.buckets[0].deviationPercent).toBeNull();
  });

  it("ignores partially measured months", () => {
    const report = buildHeatingWeatherReport(
      meter,
      [month("2026-01", 500), month("2026-02", 200, 0.4)],
      new Map(),
    );
    expect(report.buckets.map((b) => b.key)).toEqual(["2026-01"]);
  });
});

describe("buildHeatingWeatherReport — no heating meter", () => {
  it("returns an empty report with source null", () => {
    const report = buildHeatingWeatherReport(null, [], new Map());
    expect(report.source).toBeNull();
    expect(report.buckets).toEqual([]);
    expect(report.meterId).toBeNull();
  });
});
