import type { ForecastLevers, ForecastPlanActual, ForecastReverse, ForecastSensitivity, ForecastSurvivorCheck } from '../api/finance'

/** Invented answers of the robustness and reverse questions (#1339, #1340). */

const RETURNS = [0.02, 0.03, 0.04, 0.05, 0.06]
const INFLATIONS = [0.01, 0.02, 0.03]

export const SENSITIVITY: ForecastSensitivity = {
  personId: 1,
  baseReturnRate: 0.04,
  baseInflationRate: 0.02,
  returnRates: RETURNS,
  inflationRates: INFLATIONS,
  cells: RETURNS.flatMap((returnRate, ri) =>
    INFLATIONS.map((inflationRate, ii) => {
      const age = 60 + (2 - ri) + ii
      return { returnRate, inflationRate, age: age > 66 ? null : age }
    }),
  ),
}

export const LEVERS: ForecastLevers = {
  personId: 1,
  baseAge: 60,
  levers: [
    { key: 'return', label: 'Rendite 1 Prozentpunkt niedriger', age: 61, deltaYears: 1 },
    { key: 'inflation', label: 'Inflation 1 Prozentpunkt höher', age: 61, deltaYears: 1 },
    { key: 'spending', label: 'Lebenshaltung 10 % höher', age: 62, deltaYears: 2 },
    { key: 'crash', label: 'Depot verliert 30 % im Jahr des Ausstiegs', age: 63, deltaYears: 3 },
  ],
  biggest: 'crash',
}

export const REVERSE_GAP: ForecastReverse = {
  personId: 1,
  targetAge: 58,
  reachable: false,
  bufferMonthly: null,
  levers: [
    { key: 'savings', value: 640, monthlyAmount: null, bound: 20000 },
    { key: 'spending', value: 0.12, monthlyAmount: 410, bound: 0.9 },
    { key: 'return', value: null, monthlyAmount: null, bound: 0.15 },
    { key: 'one_off', value: 48000, monthlyAmount: null, bound: 5000000 },
  ],
}

export const REVERSE_OK: ForecastReverse = {
  personId: 1,
  targetAge: 62,
  reachable: true,
  bufferMonthly: 230,
  levers: [],
}

/** Death of person 1 at every age from 57 on: the early years fail, later ones leave less and less. */
export const SURVIVOR: ForecastSurvivorCheck = {
  personId: 1,
  rows: Array.from({ length: 29 }, (_, i) => {
    const age = 57 + i
    const ok = age >= 63
    return { age, year: 1970 + age, ok, failYear: ok ? null : 2052 + i, finalWealth: ok ? 20000 * (age - 62) : 0 }
  }),
  worstAge: 57,
}

/** Two snapshots against today, and a year of invented bookings (#1342). */
export const PLAN_ACTUAL: ForecastPlanActual = {
  snapshots: [
    {
      id: 2,
      takenAt: '2026-06-01T09:45:00Z',
      scenarioId: null,
      scenarioName: 'Standardannahmen',
      source: 'cron',
      startLiquid: 214000,
      startWealth: 252000,
      series: [
        { year: 2026, liquid: 226000, wealth: 266000 },
        { year: 2027, liquid: 248000, wealth: 292000 },
      ],
      plannedNow: { liquid: 220000, wealth: 259000 },
    },
    {
      id: 1,
      takenAt: '2025-09-15T10:00:00Z',
      scenarioId: 2,
      scenarioName: 'Vorsichtig',
      source: 'manual',
      startLiquid: 198000,
      startWealth: 236000,
      series: [
        { year: 2025, liquid: 201000, wealth: 240000 },
        { year: 2026, liquid: 213000, wealth: 254000 },
        { year: 2027, liquid: 226000, wealth: 269000 },
      ],
      plannedNow: { liquid: 210000, wealth: 250500 },
    },
  ],
  now: { date: '2026-09-28', liquid: 222000, wealth: 261000 },
  actuals: {
    flows: { months: 12, inflowMonthly: 6150, outflowMonthly: 3620, savingsMonthly: 2530, transfersExcluded: 36 },
    plannedSpending: 3400,
    plannedSavings: 2200,
    livingItemId: 111,
    since: '2025-09-01',
  },
}
