import type { ForecastLevers, ForecastReverse, ForecastSensitivity } from '../api/finance'

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
