import { describe, it, expect } from 'vitest'
import type { EnergyReportBucket } from '../api/meters'
import {
  ENERGY_MONTH_WINDOW,
  energyWindowBuckets,
  periodOrdinal,
  periodSpanLabel,
  periodUnit,
  slopePerPeriod,
  summarizeEnergyWindow,
} from './energySummary'

function bucket(key: string, overrides: Partial<EnergyReportBucket> = {}): EnergyReportBucket {
  const [year, month] = key.includes('-') ? key.split('-') : [key, '01']
  const start = new Date(Date.UTC(Number(year), Number(month) - 1, 1))
  const end = key.includes('-')
    ? new Date(Date.UTC(Number(year), Number(month), 1))
    : new Date(Date.UTC(Number(year) + 1, 0, 1))
  return {
    key,
    label: key,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    coverage: 1,
    complete: true,
    warnings: [],
    gridImport: null,
    gridExport: null,
    production: null,
    selfConsumption: null,
    totalConsumption: null,
    consumptionWithoutHeatPumpAndEv: null,
    autarky: null,
    selfConsumptionRate: null,
    heatPumpTotal: null,
    heatHeatingTotal: null,
    heatHeatingPv: null,
    heatHeatingGrid: null,
    heatHeatingPvShare: null,
    hotWaterTotal: null,
    hotWaterPv: null,
    hotWaterGrid: null,
    hotWaterPvShare: null,
    evChargerTotal: null,
    evChargerPv: null,
    evChargerGrid: null,
    evChargerPvShare: null,
    costs: null,
    ...overrides,
  }
}

function monthKey(index: number) {
  return `2026-${String(index).padStart(2, '0')}`
}

const NOW = new Date('2026-09-14T12:00:00Z')

describe('energyWindowBuckets', () => {
  it('keeps only the newest twelve months', () => {
    const buckets = Array.from({ length: 30 }, (_, i) =>
      bucket(`20${24 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`),
    )
    const window = energyWindowBuckets(buckets, 'month')
    expect(window).toHaveLength(ENERGY_MONTH_WINDOW)
    expect(window[0]).toBe(buckets[18])
    expect(window[window.length - 1]).toBe(buckets[29])
  })

  it('keeps every year in the year view', () => {
    const buckets = ['2019', '2020', '2021'].map((key) => bucket(key))
    expect(energyWindowBuckets(buckets, 'year')).toHaveLength(3)
  })
})

describe('periodOrdinal', () => {
  it('counts months so that a gap stays a gap', () => {
    expect(periodOrdinal('2026-03', 'month')! - periodOrdinal('2026-01', 'month')!).toBe(2)
    expect(periodOrdinal('2026-01', 'month')! - periodOrdinal('2025-11', 'month')!).toBe(2)
  })

  it('counts years in the year view', () => {
    expect(periodOrdinal('2026', 'year')).toBe(2026)
  })

  it('returns null for an unparsable key', () => {
    expect(periodOrdinal('2026-1', 'month')).toBeNull()
    expect(periodOrdinal('heuer', 'year')).toBeNull()
  })
})

describe('slopePerPeriod', () => {
  it('measures the rise per period, not per data point', () => {
    // A value that grows by 10 a month, sampled in January, February and April.
    const points = [
      { ordinal: 0, value: 0 },
      { ordinal: 1, value: 10 },
      { ordinal: 3, value: 30 },
    ]
    expect(slopePerPeriod(points)).toBeCloseTo(10, 10)
  })

  it('withholds a slope below three points and without spread', () => {
    expect(slopePerPeriod([{ ordinal: 0, value: 1 }, { ordinal: 1, value: 2 }])).toBeNull()
    expect(
      slopePerPeriod([
        { ordinal: 4, value: 1 },
        { ordinal: 4, value: 2 },
        { ordinal: 4, value: 3 },
      ]),
    ).toBeNull()
  })
})

describe('summarizeEnergyWindow', () => {
  it('averages only the periods of the window that are fully read', () => {
    const buckets = [
      // Older than the window — must not move the average.
      bucket('2024-01', { gridImport: 9_000, gridExport: 9_000 }),
      ...Array.from({ length: 12 }, (_, i) =>
        bucket(monthKey(i + 1), { gridImport: 100, gridExport: 50 }),
      ),
    ]
    const window = energyWindowBuckets(buckets, 'month')
    const summary = summarizeEnergyWindow(window, 'month', false, NOW)

    // September 2026 is the running month and drops out; eleven months remain.
    expect(summary.count).toBe(11)
    expect(summary.avgGridImport).toBe(100)
    expect(summary.avgGridExport).toBe(50)
  })

  it('leaves a partially read period out of the averages', () => {
    const window = [
      bucket('2026-01', { gridImport: 300 }),
      bucket('2026-02', { gridImport: 300 }),
      bucket('2026-03', { gridImport: 30, complete: false, coverage: 0.1 }),
    ]
    const summary = summarizeEnergyWindow(window, 'month', false, NOW)
    expect(summary.count).toBe(2)
    expect(summary.avgGridImport).toBe(300)
  })

  it('weights autarky and the self-consumption rate by energy', () => {
    const window = [
      bucket('2026-01', {
        gridImport: 900,
        totalConsumption: 1_000,
        production: 100,
        selfConsumption: 100,
      }),
      bucket('2026-02', {
        gridImport: 0,
        totalConsumption: 100,
        production: 1_000,
        selfConsumption: 100,
      }),
      bucket('2026-03', {
        gridImport: 100,
        totalConsumption: 100,
        production: 100,
        selfConsumption: 0,
      }),
    ]
    const summary = summarizeEnergyWindow(window, 'month', false, NOW)
    // 1000 of 1200 kWh came from the grid — not the mean of 10 %, 100 % and 0 %.
    expect(summary.avgAutarky).toBeCloseTo(1 - 1_000 / 1_200, 10)
    expect(summary.avgSelfConsumptionRate).toBeCloseTo(200 / 1_200, 10)
  })

  it('pairs a PV share with its own total', () => {
    const window = [
      bucket('2026-01', { heatHeatingTotal: 1_000, heatHeatingPv: 100 }),
      // No sub-meter yet: neither side counts.
      bucket('2026-02', { heatHeatingTotal: 500, heatHeatingPv: null }),
      bucket('2026-03', { heatHeatingTotal: 1_000, heatHeatingPv: 300 }),
    ]
    const summary = summarizeEnergyWindow(window, 'month', false, NOW)
    expect(summary.avgHeatHeatingPvShare).toBeCloseTo(400 / 2_000, 10)
  })

  it('sums the costs over the same periods as the averages', () => {
    const costs = (net: number) => ({
      gridImportCostEur: net,
      baseCostEur: 10,
      feedInRevenueEur: 5,
      avoidedGridCostEur: 20,
      pvBenefitEur: 25,
      netElectricityCostEur: net,
      noPvElectricityCostEur: net + 20,
    })
    const buckets = [
      bucket('2024-01', { gridImport: 100, costs: costs(1_000) }),
      ...Array.from({ length: 12 }, (_, i) =>
        bucket(monthKey(i + 1), { gridImport: 100, costs: costs(30) }),
      ),
    ]
    const window = energyWindowBuckets(buckets, 'month')
    const summary = summarizeEnergyWindow(window, 'month', true, NOW)

    // Eleven complete months of 30 € — the older year and the running month stay out.
    expect(summary.costs?.netElectricityCostEur).toBe(330)
    expect(summary.costs?.feedInRevenueEur).toBe(55)
  })

  it('reports no costs when no tariff is configured', () => {
    const summary = summarizeEnergyWindow([bucket('2026-01')], 'month', false, NOW)
    expect(summary.costs).toBeNull()
  })

  it('fits the grid-import trend over the calendar, skipping a missing month', () => {
    const window = [
      bucket('2026-01', { gridImport: 100 }),
      bucket('2026-02', { gridImport: 110 }),
      // March is missing entirely.
      bucket('2026-04', { gridImport: 130 }),
    ]
    const summary = summarizeEnergyWindow(window, 'month', false, NOW)
    expect(summary.trendGridImport).toBeCloseTo(10, 10)
    expect(summary.trendPoints).toBe(3)
  })

  it('drops the running year from the year view', () => {
    const window = [
      bucket('2024', { gridImport: 5_000 }),
      bucket('2025', { gridImport: 5_000 }),
      bucket('2026', { gridImport: 3_000 }),
    ]
    const summary = summarizeEnergyWindow(window, 'year', false, NOW)
    expect(summary.count).toBe(2)
    expect(summary.avgGridImport).toBe(5_000)
  })
})

describe('period labels', () => {
  it('names the denominator of an average', () => {
    expect(periodUnit('month')).toBe('Monat')
    expect(periodUnit('year')).toBe('Jahr')
  })

  it('names the span of a sum', () => {
    expect(periodSpanLabel(12, 'month')).toBe('12 Monate')
    expect(periodSpanLabel(1, 'month')).toBe('1 Monat')
    expect(periodSpanLabel(5, 'year')).toBe('5 Jahre')
    expect(periodSpanLabel(1, 'year')).toBe('1 Jahr')
  })
})
