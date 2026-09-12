import { describe, expect, it } from "vitest";
import {
  MAX_BASELINE_INTERVAL_DAYS,
  MIN_COMPRESSOR_RUNTIME_SHARE,
  buildCompressorEfficiency,
  buildOperatingHoursMetric,
  buildPvYield,
  buildWaterBaseline,
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
    meanIntervalDays: 30,
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

  it("flags more hours than the period contains instead of hiding them", () => {
    const metric = buildOperatingHoursMetric(meter(), report([january(2026, 900)]));

    // 900 of 744 hours is a data error the reader should see, not a machine
    // that ran flat out; clamping to 100 % would make it look plausible.
    expect(metric.buckets[0].runtimeShare).toBe(1.21);
    expect(metric.buckets[0].implausible).toBe(true);
    expect(buildOperatingHoursMetric(meter(), report([january(2026, 744)])).buckets[0].implausible).toBe(
      false,
    );
  });

  it("averages only over fully measured periods", () => {
    const metric = buildOperatingHoursMetric(
      meter(),
      report([january(2026, 372), january(2025, 100, 0.4)]),
    );

    // The partial month is left out, so the average is the full month's 50 %.
    expect(metric.averageRuntimeShare).toBe(0.5);
  });

  it("weights the average by period length", () => {
    // January (744 h) at 50 %, February (672 h) at 0 %: the plain mean of the
    // two shares would be 25 %, the hours-weighted share is 372 / 1416.
    const february = bucket({
      key: "2026-02",
      label: "02.2026",
      periodStart: "2026-02-01T00:00:00.000Z",
      periodEnd: "2026-03-01T00:00:00.000Z",
      consumption: 0,
    });
    const metric = buildOperatingHoursMetric(meter(), report([january(2026, 372), february]));

    expect(metric.averageRuntimeShare).toBe(0.263);
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
    expect(efficiency.latestKey).toBe("2026");
    // The change compares with the year before, not with the first record.
    expect(efficiency.previousYearKwhPerHour).toBe(2.2);
    expect(efficiency.changePercent).toBe(0.091);
    expect(efficiency.buckets[2].previousYearKwhPerHour).toBe(2.2);
    expect(efficiency.slopePerYear).toBeCloseTo(0.2, 3);
  });

  it("compares a month with the same month a year earlier, never with July", () => {
    const efficiency = buildCompressorEfficiency(
      1,
      2,
      [january(2025, 1000), january(2026, 1200)],
      [january(2025, 500), january(2026, 500)],
      "month",
    );

    expect(efficiency.previousYearKwhPerHour).toBe(2);
    expect(efficiency.changePercent).toBe(0.2);
    // Two points are no line.
    expect(efficiency.slopePerYear).toBeNull();
  });

  it("runs the slope over calendar time so a missing year is not squeezed out", () => {
    const efficiency = buildCompressorEfficiency(
      1,
      2,
      [yearBucket(2021, 1000), yearBucket(2022, 1100), yearBucket(2026, 1500)],
      [yearBucket(2021, 500), yearBucket(2022, 500), yearBucket(2026, 500)],
      "year",
    );

    // 2.0, 2.2, 3.0 over five years is 0.2 per year, not 0.5 per list step.
    expect(efficiency.slopePerYear).toBeCloseTo(0.2, 3);
  });

  it("withholds the ratio when the compressor barely ran", () => {
    // Summer: 10 of 744 hours is standby and start-ups, not the pump's condition.
    const threshold = 744 * MIN_COMPRESSOR_RUNTIME_SHARE;
    const below = buildCompressorEfficiency(
      1,
      2,
      [january(2026, 100)],
      [january(2026, threshold - 1)],
      "month",
    );
    const above = buildCompressorEfficiency(
      1,
      2,
      [january(2026, 100)],
      [january(2026, threshold)],
      "month",
    );

    expect(below.buckets[0].kwhPerHour).toBeNull();
    expect(above.buckets[0].kwhPerHour).not.toBeNull();
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
    expect(buckets[0].averageDailyRate).toBe(1);
    // A single ten-day interval cannot separate a quiet stretch from the rest.
    expect(buckets[0].minDailyRate).toBeNull();
  });

  it("withholds the baseline while there is only one long interval per period", () => {
    const monthly = buildWaterBaselineBuckets(
      [
        { takenAt: "2026-01-01T00:00:00.000Z", value: 0 },
        { takenAt: "2026-02-01T00:00:00.000Z", value: 31 },
        { takenAt: "2026-03-01T00:00:00.000Z", value: 59 },
      ],
      "month",
    );

    // With one reading a month the minimum is the average and says nothing.
    expect(monthly).toHaveLength(2);
    expect(monthly.every((bucket) => bucket.minDailyRate === null)).toBe(true);
    expect(monthly[0].averageDailyRate).toBe(1);
    expect(monthly[0].shortestIntervalDays).toBe(31);
    expect(monthly[0].measuredDays).toBe(31);
  });

  it("accepts a single interval when it is short enough to be a quiet stretch", () => {
    const buckets = buildWaterBaselineBuckets(
      [
        { takenAt: "2026-01-01T00:00:00.000Z", value: 0 },
        { takenAt: `2026-01-0${1 + MAX_BASELINE_INTERVAL_DAYS}T00:00:00.000Z`, value: 14 },
      ],
      "month",
    );

    expect(buckets[0].intervals).toBe(1);
    expect(buckets[0].minDailyRate).toBe(2);
  });

  it("leaves intervals outside the requested range out", () => {
    const buckets = buildWaterBaselineBuckets(
      [
        { takenAt: "2025-12-20T00:00:00.000Z", value: 0 },
        { takenAt: "2026-01-01T00:00:00.000Z", value: 12 },
        { takenAt: "2026-01-11T00:00:00.000Z", value: 22 },
        { takenAt: "2026-01-21T00:00:00.000Z", value: 24 },
        { takenAt: "2026-02-01T00:00:00.000Z", value: 30 },
        { takenAt: "2026-02-11T00:00:00.000Z", value: 40 },
      ],
      "month",
      { from: new Date("2026-01-01T00:00:00.000Z"), to: new Date("2026-02-01T00:00:00.000Z") },
    );

    // December's interval is out, the three starting in January are in —
    // including the one that ends in February.
    expect(buckets.map((bucket) => bucket.key)).toEqual(["2026-01"]);
    expect(buckets[0].intervals).toBe(3);
  });
});

describe("buildWaterBaseline", () => {
  const water = () => meter({ id: 7, name: "Wasser", type: "water", unit: "m³" });

  /** Weekly readings over a whole January, `floor` per day with one busier week. */
  function januaryReadings(year: number, floor: number) {
    let value = 0;
    const readings = [{ takenAt: `${year}-01-01T00:00:00.000Z`, value }];
    for (const [day, rate] of [
      [8, floor],
      [15, floor * 3],
      [22, floor],
      [29, floor],
    ] as const) {
      value += rate * 7;
      readings.push({ takenAt: `${year}-01-${String(day).padStart(2, "0")}T00:00:00.000Z`, value });
    }
    return readings;
  }

  it("compares the latest floor with the same period a year earlier", () => {
    const baseline = buildWaterBaseline(
      water(),
      [...januaryReadings(2025, 0.1), ...januaryReadings(2026, 0.15)],
      "month",
    );

    expect(baseline.latestKey).toBe("2026-01");
    expect(baseline.latestMinDailyRate).toBe(0.15);
    expect(baseline.previousYearMinDailyRate).toBe(0.1);
    expect(baseline.changePercent).toBe(0.5);
    expect(baseline.tooSparse).toBe(false);
  });

  it("does not compare a period that was measured only for a few days", () => {
    const baseline = buildWaterBaseline(
      water(),
      [
        ...januaryReadings(2025, 0.1),
        // 2026: two readings three days apart, nothing else in the month.
        { takenAt: "2026-01-10T00:00:00.000Z", value: 100 },
        { takenAt: "2026-01-13T00:00:00.000Z", value: 100.9 },
      ],
      "month",
    );

    // The sparse month is reported but not used as "latest".
    expect(baseline.buckets.map((bucket) => bucket.key)).toEqual(["2025-01", "2026-01"]);
    expect(baseline.latestKey).toBe("2025-01");
    expect(baseline.previousYearMinDailyRate).toBeNull();
  });

  it("says so when no period has readings close enough for a baseline", () => {
    const baseline = buildWaterBaseline(
      water(),
      [
        { takenAt: "2026-01-01T00:00:00.000Z", value: 0 },
        { takenAt: "2026-02-01T00:00:00.000Z", value: 31 },
        { takenAt: "2026-03-01T00:00:00.000Z", value: 59 },
      ],
      "month",
    );

    expect(baseline.tooSparse).toBe(true);
    expect(baseline.latestMinDailyRate).toBeNull();
  });
});

describe("buildPvYield", () => {
  it("normalises production against the installed capacity", () => {
    const yieldReport = buildPvYield(1, 10, [yearBucket(2026, 9500)]);

    expect(yieldReport.buckets[0].yieldPerKwp).toBe(950);
  });

  it("compares the latest year with the year before, the median and the best", () => {
    const yieldReport = buildPvYield(1, 10, [
      yearBucket(2022, 9800),
      yearBucket(2023, 10000),
      yearBucket(2024, 9200),
      yearBucket(2025, 9500),
      yearBucket(2026, 9000),
    ]);

    expect(yieldReport.latestKey).toBe("2026");
    expect(yieldReport.latestYieldPerKwp).toBe(900);
    expect(yieldReport.previousYearYieldPerKwp).toBe(950);
    expect(yieldReport.changeVsPreviousYearPercent).toBe(-0.053);
    // Median of the other years (920, 950, 980, 1000) is 965: the best year
    // is the luckiest weather, against it every ordinary year looks like decline.
    expect(yieldReport.medianYieldPerKwp).toBe(965);
    expect(yieldReport.changeVsMedianPercent).toBe(-0.067);
    expect(yieldReport.bestYieldPerKwp).toBe(1000);
    expect(yieldReport.changeVsBestPercent).toBe(-0.1);
  });

  it("uses the capacity that was installed in each year", () => {
    // The plant was extended from 5 to 10 kWp for 2026: production doubles,
    // the yield per kWp does not.
    const yieldReport = buildPvYield(
      1,
      10,
      [yearBucket(2025, 4750), yearBucket(2026, 9500)],
      (periodStart) => (periodStart < "2026" ? 5 : 10),
    );

    expect(yieldReport.buckets[0].capacityKwp).toBe(5);
    expect(yieldReport.buckets[0].yieldPerKwp).toBe(950);
    expect(yieldReport.buckets[1].yieldPerKwp).toBe(950);
    expect(yieldReport.changeVsPreviousYearPercent).toBe(0);
  });

  it("has no yield for a year before the plant existed", () => {
    const yieldReport = buildPvYield(1, 10, [yearBucket(2025, 0), yearBucket(2026, 9500)], (periodStart) =>
      periodStart < "2026" ? null : 10,
    );

    expect(yieldReport.buckets[0].yieldPerKwp).toBeNull();
    expect(yieldReport.previousYearYieldPerKwp).toBeNull();
  });

  it("leaves partial periods out so they do not look like degradation", () => {
    const yieldReport = buildPvYield(1, 10, [yearBucket(2026, 4000, 0.4)]);

    expect(yieldReport.buckets[0].yieldPerKwp).toBeNull();
    expect(yieldReport.latestYieldPerKwp).toBeNull();
  });
});
