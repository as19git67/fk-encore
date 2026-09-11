/**
 * Utility meters — seasonal profile of autarky and self-consumption rate
 * (Issue #792, report A3 / #1022).
 *
 * A heatmap year × month for both ratios. It answers at a glance in which
 * months the PV system (and a battery, if any) carries the household and
 * whether that improves over the years. No new data is needed: the monthly
 * energy report already carries both ratios per bucket; this only pivots them
 * into a grid and adds row/column averages.
 */

import { APIError } from "encore.dev/api";
import {
  getEnergyReportForUser,
  COMPLETE_COVERAGE_THRESHOLD,
  type EnergyReportBucket,
} from "./reports.service";

export type SeasonProfileMetricKey = "autarky" | "selfConsumptionRate";

export interface SeasonProfileYear {
  year: number;
  /** Index 0 = January … 11 = December; null where the month is not fully measured. */
  months: Array<number | null>;
  /** Mean over the measured months of this year. */
  average: number | null;
  measuredMonths: number;
}

export interface SeasonProfileMetric {
  key: SeasonProfileMetricKey;
  label: string;
  years: SeasonProfileYear[];
  /** Mean per calendar month across all years, index 0 = January. */
  monthAverages: Array<number | null>;
  /** Lowest and highest cell value, for the colour scale. */
  min: number | null;
  max: number | null;
}

export interface SeasonProfileReport {
  metrics: SeasonProfileMetric[];
  /** Months that went into the grid. */
  monthsMeasured: number;
}

const METRICS: Array<{ key: SeasonProfileMetricKey; label: string }> = [
  { key: "autarky", label: "Autarkie" },
  { key: "selfConsumptionRate", label: "Eigenverbrauchsquote" },
];

function ratio(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return ratio(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** Pivot monthly energy buckets into a year × month grid per ratio. */
export function buildSeasonProfile(buckets: EnergyReportBucket[]): SeasonProfileReport {
  const complete = buckets.filter(
    (bucket) => bucket.coverage >= COMPLETE_COVERAGE_THRESHOLD && /^\d{4}-\d{2}$/.test(bucket.key),
  );

  const metrics = METRICS.map(({ key, label }): SeasonProfileMetric => {
    const byYear = new Map<number, Array<number | null>>();
    for (const bucket of complete) {
      const value = bucket[key];
      if (value === null) continue;
      const [yearRaw, monthRaw] = bucket.key.split("-");
      const year = Number(yearRaw);
      const row = byYear.get(year) ?? new Array<number | null>(12).fill(null);
      row[Number(monthRaw) - 1] = value;
      byYear.set(year, row);
    }

    const years = [...byYear.entries()]
      .sort(([a], [b]) => a - b)
      .map(([year, months]): SeasonProfileYear => {
        const measured = months.filter((value): value is number => value !== null);
        return { year, months, average: mean(measured), measuredMonths: measured.length };
      });

    const monthAverages = Array.from({ length: 12 }, (_, month) =>
      mean(
        years
          .map((row) => row.months[month])
          .filter((value): value is number => value !== null),
      ),
    );

    const all = years.flatMap((row) =>
      row.months.filter((value): value is number => value !== null),
    );

    return {
      key,
      label,
      years,
      monthAverages,
      min: all.length > 0 ? Math.min(...all) : null,
      max: all.length > 0 ? Math.max(...all) : null,
    };
  });

  return { metrics, monthsMeasured: complete.length };
}

export async function getSeasonProfileForUser(
  userId: number,
  fromDate: Date | null,
  toDate: Date | null,
): Promise<SeasonProfileReport> {
  if (fromDate && toDate && fromDate >= toDate) {
    throw APIError.invalidArgument("from must be before to");
  }
  const energy = await getEnergyReportForUser(userId, "month", fromDate, toDate);
  return buildSeasonProfile(energy.buckets);
}
