import type {
  EnergyReportBucket,
  EnergyTariffCosts,
  MeterReportGranularity,
} from '../api/meters'

/**
 * Aggregates for the energy block.
 *
 * The block shows a window of periods — the twelve newest months, or every
 * year — and all its figures have to describe exactly that window, so that
 * adding up the table by hand gives the same answer. Only periods the backend
 * marked `complete` count: a partially read month would otherwise drag every
 * average down without appearing in full in the table.
 */

/** How many of the newest months the month view shows. */
export const ENERGY_MONTH_WINDOW = 12

type Selector = (bucket: EnergyReportBucket) => number | null

/** The periods the table shows, oldest first. */
export function energyWindowBuckets(
  buckets: EnergyReportBucket[],
  granularity: MeterReportGranularity,
): EnergyReportBucket[] {
  return granularity === 'month' ? buckets.slice(-ENERGY_MONTH_WINDOW) : buckets
}

/**
 * The period a bucket key names, counted in periods since year zero. Regression
 * over this axis keeps a missing month a gap instead of silently closing it.
 */
export function periodOrdinal(
  key: string,
  granularity: MeterReportGranularity,
): number | null {
  if (granularity === 'year') {
    const year = Number(key)
    return Number.isFinite(year) ? year : null
  }
  const match = /^(\d{4})-(\d{2})$/.exec(key)
  if (!match) return null
  return Number(match[1]) * 12 + Number(match[2]) - 1
}

/** Slope per period over a real time axis; null below three points. */
export function slopePerPeriod(
  points: Array<{ ordinal: number; value: number }>,
): number | null {
  if (points.length < 3) return null
  const meanX = points.reduce((sum, p) => sum + p.ordinal, 0) / points.length
  const meanY = points.reduce((sum, p) => sum + p.value, 0) / points.length
  let numerator = 0
  let denominator = 0
  for (const point of points) {
    const dx = point.ordinal - meanX
    numerator += dx * (point.value - meanY)
    denominator += dx * dx
  }
  if (denominator === 0) return null
  return numerator / denominator
}

export function isCurrentPeriod(
  key: string,
  granularity: MeterReportGranularity,
  now: Date,
): boolean {
  if (granularity === 'year') return key === String(now.getFullYear())
  return key === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export interface EnergySummary {
  /** Complete periods inside the window — the basis of every figure below. */
  count: number
  /** Periods the trend lines were fitted over. */
  trendPoints: number
  avgGridImport: number | null
  avgGridExport: number | null
  avgProduction: number | null
  avgSelfConsumption: number | null
  avgTotalConsumption: number | null
  avgConsumptionWithoutHeatPumpAndEv: number | null
  avgHeatPumpTotal: number | null
  avgHeatHeatingTotal: number | null
  avgHotWaterTotal: number | null
  avgEvChargerTotal: number | null
  /** Energy-weighted, so it matches the sums of the shown columns. */
  avgAutarky: number | null
  avgSelfConsumptionRate: number | null
  avgHeatHeatingPvShare: number | null
  avgHotWaterPvShare: number | null
  avgEvChargerPvShare: number | null
  trendGridImport: number | null
  trendAutarky: number | null
  /** Sums over the same periods; null when no tariffs are configured. */
  costs: EnergyTariffCosts | null
}

/**
 * Sums a share over the periods where *both* sides are known — averaging the
 * monthly percentages instead would weight a February like a July.
 */
function pairedShare(
  buckets: EnergyReportBucket[],
  totalOf: Selector,
  pvOf: Selector,
): number | null {
  const pairs = buckets.filter((b) => totalOf(b) !== null && pvOf(b) !== null)
  if (pairs.length === 0) return null
  const total = pairs.reduce((sum, b) => sum + (totalOf(b) as number), 0)
  const pv = pairs.reduce((sum, b) => sum + (pvOf(b) as number), 0)
  return total > 0 ? Math.min(1, pv / total) : null
}

function pairedRatio(
  buckets: EnergyReportBucket[],
  numeratorOf: Selector,
  denominatorOf: Selector,
): number | null {
  const pairs = buckets.filter((b) => numeratorOf(b) !== null && denominatorOf(b) !== null)
  if (pairs.length === 0) return null
  const denominator = pairs.reduce((sum, b) => sum + (denominatorOf(b) as number), 0)
  if (denominator <= 0) return null
  const numerator = pairs.reduce((sum, b) => sum + (numeratorOf(b) as number), 0)
  return numerator / denominator
}

/** Aggregates the complete periods of a window into the figures above. */
export function summarizeEnergyWindow(
  window: EnergyReportBucket[],
  granularity: MeterReportGranularity,
  hasTariffs: boolean,
  now: Date = new Date(),
): EnergySummary {
  const complete = window.filter(
    (bucket) => bucket.complete && !isCurrentPeriod(bucket.key, granularity, now),
  )
  const avg = (selector: Selector) => {
    const values = complete.map(selector).filter((value): value is number => value !== null)
    if (values.length === 0) return null
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }
  const trend = (selector: Selector) => {
    const points = complete
      .map((bucket) => ({
        ordinal: periodOrdinal(bucket.key, granularity),
        value: selector(bucket),
      }))
      .filter(
        (point): point is { ordinal: number; value: number } =>
          point.ordinal !== null && point.value !== null,
      )
    return slopePerPeriod(points)
  }
  const costSum = (selector: (costs: EnergyTariffCosts) => number | null) => {
    const values = complete
      .map((bucket) => (bucket.costs ? selector(bucket.costs) : null))
      .filter((value): value is number => value !== null)
    if (values.length === 0) return null
    return Math.round(values.reduce((sum, value) => sum + value, 0) * 100) / 100
  }

  return {
    count: complete.length,
    trendPoints: complete.length,
    avgGridImport: avg((bucket) => bucket.gridImport),
    avgGridExport: avg((bucket) => bucket.gridExport),
    avgProduction: avg((bucket) => bucket.production),
    avgSelfConsumption: avg((bucket) => bucket.selfConsumption),
    avgTotalConsumption: avg((bucket) => bucket.totalConsumption),
    avgConsumptionWithoutHeatPumpAndEv: avg((bucket) => bucket.consumptionWithoutHeatPumpAndEv),
    avgHeatPumpTotal: avg((bucket) => bucket.heatPumpTotal),
    avgHeatHeatingTotal: avg((bucket) => bucket.heatHeatingTotal),
    avgHotWaterTotal: avg((bucket) => bucket.hotWaterTotal),
    avgEvChargerTotal: avg((bucket) => bucket.evChargerTotal),
    avgAutarky: (() => {
      const share = pairedRatio(
        complete,
        (bucket) => bucket.gridImport,
        (bucket) => bucket.totalConsumption,
      )
      return share === null ? null : 1 - share
    })(),
    avgSelfConsumptionRate: pairedRatio(
      complete,
      (bucket) => bucket.selfConsumption,
      (bucket) => bucket.production,
    ),
    avgHeatHeatingPvShare: pairedShare(
      complete,
      (bucket) => bucket.heatHeatingTotal,
      (bucket) => bucket.heatHeatingPv,
    ),
    avgHotWaterPvShare: pairedShare(
      complete,
      (bucket) => bucket.hotWaterTotal,
      (bucket) => bucket.hotWaterPv,
    ),
    avgEvChargerPvShare: pairedShare(
      complete,
      (bucket) => bucket.evChargerTotal,
      (bucket) => bucket.evChargerPv,
    ),
    trendGridImport: trend((bucket) => bucket.gridImport),
    trendAutarky: trend((bucket) => bucket.autarky),
    costs: hasTariffs
      ? {
          gridImportCostEur: costSum((costs) => costs.gridImportCostEur),
          baseCostEur: costSum((costs) => costs.baseCostEur),
          feedInRevenueEur: costSum((costs) => costs.feedInRevenueEur),
          avoidedGridCostEur: costSum((costs) => costs.avoidedGridCostEur),
          selfConsumptionVatEur: costSum((costs) => costs.selfConsumptionVatEur),
          pvBenefitEur: costSum((costs) => costs.pvBenefitEur),
          netElectricityCostEur: costSum((costs) => costs.netElectricityCostEur),
          noPvElectricityCostEur: costSum((costs) => costs.noPvElectricityCostEur),
        }
      : null,
  }
}

/** "Monat" / "Jahr" — the denominator that turns an average into a rate. */
export function periodUnit(granularity: MeterReportGranularity): string {
  return granularity === 'year' ? 'Jahr' : 'Monat'
}

/** "12 Monate" / "5 Jahre" — the span a sum covers. */
export function periodSpanLabel(
  count: number,
  granularity: MeterReportGranularity,
): string {
  if (granularity === 'year') return count === 1 ? '1 Jahr' : `${count} Jahre`
  return count === 1 ? '1 Monat' : `${count} Monate`
}
