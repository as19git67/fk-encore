import { describe, expect, it } from "vitest";
import {
  buildCompressorEfficiency,
  buildOperatingHoursMetric,
  buildPvYield,
  buildWaterBaselineBuckets,
} from "./equipment.service";
import type { MeterReport, MeterReportBucket } from "./reports.service";
import type { MeterListItem } from "./meter.service";

function bucket(overrides: Partial<MeterReportBucket> = {}): MeterReportBucket {
  return {
    key: "2026-01",
    label: "01.2026",
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-02-01T00:00:00.000Z",
    startReadingAt: "2026-01-01T00:00:00.000Z",
    endReadingAt: "2026-02-01T00:00:00.000Z",
    startValue: 0,
    endValue: 0,
    consumption: 0,
    intervals: 1,
    coverage: 1,
    previousConsumption: null,
    deltaAbsolute: null,
    deltaPercent: null,
    ...overrides,
  };
}

/** A January bucket for `year` with the given consumption. */
function january(year: number, consumption: number, coverage = 1): MeterReportBucket {
  return bucket({
    key: `${year}-01`,
    label: `01.${year}`,
    periodStart: `${year}-01-01T00:00:00.000Z`,
    periodEnd: `${year}-02-01T00:00:00.000Z`,
    consumption,
    coverage,
  });
}

function yearBucket(year: number, consumption: number, coverage = 1): MeterReportBucket {
  return bucket({
    key: String(year),
    label: String(year),
    periodStart: `${year}-01-01T00:00:00.000Z`,
    periodEnd: `${year + 1}-01-01T00:00:00.000Z`,
    consumption,
    coverage,
  });
}

const meter = (overrides: Partial<MeterListItem> = {}) =>
  ({
    id: 1,
    name: "Verdichter",
    type: "operating_hours",
    role: null,
    unit: "h",
    location: null,
    notes: null,
    decimals: 1,
    groupId: null,
    ownerUserId: 1,
    activeDeviceSerial: null,
    lastReadingValue: null,
    lastReadingAt: null,
    absoluteTotal: 0,
    ...overrides,
  }) as MeterListItem;

const report = (buckets: MeterReportBucket[]) =>
  ({
    meterId: 1,
    name: "Verdichter",
    unit: "h",
    decimals: 1,
    granularity: "month" as const,
    allocation: "interpolated" as const,
    from: null,
    to: null,
    buckets,
    totalConsumption: buckets.reduce((sum, b) => sum + b.consumption, 0),
  }) as MeterReport;

describe("buildOperatingHoursMetric", () => {
  it("expresses the hours as a share of the period", () => {
    // January has 744 hours; 186 of them is a quarter.
    const metric = buildOperatingHoursMetric(meter(), report([january(2026, 186)]));

    expect(metric.buckets[0].runtimeShare).toBe(0.25);
    expect(metric.totalHours).toBe(186);
  });

  it("measures the share against the measured slice, not the whole period", () => {
    // Only half the month was measured, and the machine ran a quarter of it.
    const metric = buildOperatingHoursMetric(meter(), report([january(2026, 93, 0.5)]));

    expect(metric.buckets[0].runtimeShare).toBe(0.25);
  });

  it("caps the share at 100 percent", () => {
    const metric = buildOperatingHoursMetric(meter(), report([january(2026, 900)]));

    expect(metric.buckets[0].runtimeShare).toBe(1);
  });

  it("averages only over fully measured periods", () => {
    const metric = buildOperatingHoursMetric(
      meter(),
      report([january(2026, 372), january(2025, 100, 0.4)]),
    );

    // The partial month is left out, so the average is the full month's 50 %.
    expect(metric.averageRuntimeShare).toBe(0.5);
  });
});

describe("buildCompressorEfficiency", () => {
  it("divides the heat pump electricity by the compressor hours", () => {
    const efficiency = buildCompressorEfficiency(
      1,
      2,
      [january(2026, 1000)],
      [january(2026, 500)],
      "month",
    );

    expect(efficiency.buckets[0].kwhPerHour).toBe(2);
  });

  it("skips the ratio when either side is only partially measured", () => {
    const efficiency = buildCompressorEfficiency(
      1,
      2,
      [january(2026, 1000)],
      [january(2026, 500, 0.5)],
      "month",
    );

    expect(efficiency.buckets[0].kwhPerHour).toBeNull();
  });

  it("reports a rising ratio as losing efficiency", () => {
    const efficiency = buildCompressorEfficiency(
      1,
      2,
      [yearBucket(2024, 1000), yearBucket(2025, 1100), yearBucket(2026, 1200)],
      [yearBucket(2024, 500), yearBucket(2025, 500), yearBucket(2026, 500)],
      "year",
    );

    expect(efficiency.earliestKwhPerHour).toBe(2);
    expect(efficiency.latestKwhPerHour).toBe(2.4);
    expect(efficiency.changePercent).toBe(0.2);
    expect(efficiency.slopePerYear).toBeGreaterThan(0);
  });

  it("leaves the ratio empty when the compressor did not run", () => {
    const efficiency = buildCompressorEfficiency(
      1,
      2,
      [january(2026, 1000)],
      [january(2026, 0)],
      "month",
    );

    expect(efficiency.buckets[0].kwhPerHour).toBeNull();
  });
});

describe("buildWaterBaselineBuckets", () => {
  it("reports the lowest daily rate of the period, not the average", () => {
    const buckets = buildWaterBaselineBuckets(
      [
        // 10 days at 1.0/day, then 10 days at 0.2/day.
        { takenAt: "2026-01-01T00:00:00.000Z", value: 0 },
        { takenAt: "2026-01-11T00:00:00.000Z", value: 10 },
        { takenAt: "2026-01-21T00:00:00.000Z", value: 12 },
      ],
      "month",
    );

    expect(buckets[0].minDailyRate).toBe(0.2);
    expect(buckets[0].averageDailyRate).toBe(0.6);
    expect(buckets[0].intervals).toBe(2);
  });

  it("shows a rising floor even when the average stays put", () => {
    // Same total over the same 20 days in both years, but the quiet stretch is
    // no longer quiet — exactly the signature of a leak the total would hide.
    const quietYear = buildWaterBaselineBuckets(
      [
        { takenAt: "2025-01-01T00:00:00.000Z", value: 0 },
        { takenAt: "2025-01-11T00:00:00.000Z", value: 10 },
        { takenAt: "2025-01-21T00:00:00.000Z", value: 12 },
      ],
      "month",
    )[0];
    const leakingYear = buildWaterBaselineBuckets(
      [
        { takenAt: "2026-01-01T00:00:00.000Z", value: 0 },
        { takenAt: "2026-01-11T00:00:00.000Z", value: 6 },
        { takenAt: "2026-01-21T00:00:00.000Z", value: 12 },
      ],
      "month",
    )[0];

    expect(quietYear.averageDailyRate).toBe(leakingYear.averageDailyRate);
    expect(quietYear.minDailyRate).toBe(0.2);
    expect(leakingYear.minDailyRate).toBe(0.6);
  });

  it("charges an interval to the period it starts in", () => {
    // A long gap starting in January belongs to January, whatever it spans.
    const buckets = buildWaterBaselineBuckets(
      [
        { takenAt: "2026-01-20T00:00:00.000Z", value: 0 },
        { takenAt: "2026-03-21T00:00:00.000Z", value: 60 },
      ],
      "month",
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0].key).toBe("2026-01");
  });

  it("ignores intervals that go backwards", () => {
    const buckets = buildWaterBaselineBuckets(
      [
        { takenAt: "2026-01-01T00:00:00.000Z", value: 10 },
        { takenAt: "2026-01-11T00:00:00.000Z", value: 5 },
        { takenAt: "2026-01-21T00:00:00.000Z", value: 15 },
      ],
      "month",
    );

    expect(buckets[0].intervals).toBe(1);
    expect(buckets[0].minDailyRate).toBe(1);
  });
});

describe("buildPvYield", () => {
  it("normalises production against the installed capacity", () => {
    const yieldReport = buildPvYield(1, 10, [yearBucket(2026, 9500)]);

    expect(yieldReport.buckets[0].yieldPerKwp).toBe(950);
  });

  it("compares the latest period with the best on record", () => {
    const yieldReport = buildPvYield(1, 10, [
      yearBucket(2024, 10000),
      yearBucket(2025, 9500),
      yearBucket(2026, 9000),
    ]);

    expect(yieldReport.bestYieldPerKwp).toBe(1000);
    expect(yieldReport.latestYieldPerKwp).toBe(900);
    expect(yieldReport.changeVsBestPercent).toBe(-0.1);
  });

  it("leaves partial periods out so they do not look like degradation", () => {
    const yieldReport = buildPvYield(1, 10, [yearBucket(2026, 4000, 0.4)]);

    expect(yieldReport.buckets[0].yieldPerKwp).toBeNull();
    expect(yieldReport.latestYieldPerKwp).toBeNull();
  });
});
