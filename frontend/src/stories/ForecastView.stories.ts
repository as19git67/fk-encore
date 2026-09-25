import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import ForecastView from '../views/finance/ForecastView.vue'
import { defaultHandlers } from './handlers'
import { routeFromParameters } from './storyRoute'
import { STATEMENTS } from './forecastStatementsFixture'
import type {
  ForecastBundle,
  ForecastSimulateRequest,
  ForecastSimulateResponse,
  ForecastSimulation,
  ForecastYearRow,
} from '../api/finance'

/**
 * Finanzen › Prognose (issue #1337). The household below is invented:
 * two persons with round birthdays, a salary, a pension each, one life
 * insurance and a depot. The "simulation" the handler answers with is a
 * toy curve that has the right shape — a bridge between leaving work and
 * the pension, then a slow decline — so the charts have something to say.
 */

const DEFAULT_SCENARIO: ForecastBundle['defaultScenario'] = {
  inflationRate: 0.02,
  defaultReturnRate: 0.04,
  capitalGainsTaxRate: 0.26375,
  depotGainShare: 0.5,
  minLiquidWealth: 0,
  endAge: 95,
  milestoneOverrides: {},
  withdrawalOrder: ['cash', 'depot', 'other'],
  allowSurrender: false,
  spendingCurve: {
    referencePersonId: null,
    phases: [
      { fromAge: 0, factor: 1 },
      { fromAge: 75, factor: 0.85 },
      { fromAge: 85, factor: 0.75 },
    ],
    careFromAge: 85,
    careMonthly: 0,
  },
  healthInsurance: { rate: 0.2, minMonthly: 250 },
  offsetDeductions: [],
}

const BUNDLE: ForecastBundle = {
  persons: [
    { id: 1, label: 'Alex', birthDate: '1970-04-01', sortOrder: 0 },
    { id: 2, label: 'Kim', birthDate: '1973-09-01', sortOrder: 1 },
  ],
  milestones: [
    { id: 11, personId: 1, kind: 'leave_work', label: 'Ausstieg aus dem Beruf', date: null, age: 61 },
    { id: 12, personId: 1, kind: 'statutory_pension', label: 'Gesetzliche Rente', date: null, age: 66 },
    { id: 13, personId: 1, kind: 'life_insurance_maturity', label: 'Ablauf Lebensversicherung', date: '2032-12-01', age: null },
    { id: 21, personId: 2, kind: 'leave_work', label: 'Ausstieg aus dem Beruf', date: null, age: 63 },
    { id: 22, personId: 2, kind: 'statutory_pension', label: 'Gesetzliche Rente', date: null, age: 67 },
    { id: 23, personId: 2, kind: 'company_pension', label: 'Betriebsrente', date: null, age: 65 },
  ],
  items: [
    { id: 101, personId: 1, type: 'salary', label: 'Gehalt Alex', data: { amount: 3200, growthRate: 0.02 }, linkedAccountId: null, linkedAccountBalance: null, sortOrder: 0 },
    { id: 102, personId: 2, type: 'salary', label: 'Gehalt Kim', data: { amount: 2800, growthRate: 0.02 }, linkedAccountId: null, linkedAccountBalance: null, sortOrder: 0 },
    {
      id: 103,
      personId: 1,
      type: 'pension',
      label: 'Gesetzliche Rente Alex',
      data: { kind: 'statutory', monthlyAmount: 1700, start: { kind: 'milestone', milestoneId: 12 }, regularAge: 67, deductionPerMonth: 0.003, deductionOffsetCost: 24000, growthRate: 0.02 },
      linkedAccountId: null,
      linkedAccountBalance: null,
      sortOrder: 0,
    },
    {
      id: 104,
      personId: 2,
      type: 'pension',
      label: 'Gesetzliche Rente Kim',
      data: { kind: 'statutory', monthlyAmount: 1500, start: { kind: 'milestone', milestoneId: 22 }, regularAge: 67, deductionPerMonth: 0.003, growthRate: 0.02 },
      linkedAccountId: null,
      linkedAccountBalance: null,
      sortOrder: 0,
    },
    {
      id: 105,
      personId: 2,
      type: 'pension',
      label: 'Betriebsrente Kim',
      data: { kind: 'company', monthlyAmount: 400, start: { kind: 'milestone', milestoneId: 23 }, lumpSumOption: 60000, payoutMode: 'annuity' },
      linkedAccountId: null,
      linkedAccountBalance: null,
      sortOrder: 0,
    },
    {
      id: 106,
      personId: 1,
      type: 'life_insurance',
      label: 'Lebensversicherung Alex',
      data: { surrenderValue: 38000, monthlyPremium: 150, projectedPayout: 62000, guaranteedPayout: 55000, maturity: { kind: 'milestone', milestoneId: 13 }, payoutMode: 'lump_sum' },
      linkedAccountId: null,
      linkedAccountBalance: null,
      sortOrder: 0,
    },
    { id: 107, personId: 1, type: 'health_insurance', label: 'KV Alex', data: { employedAmount: 420, bridgeMode: 'statutory_voluntary', retiredMode: 'kvdr' }, linkedAccountId: null, linkedAccountBalance: null, sortOrder: 0 },
    { id: 108, personId: 2, type: 'health_insurance', label: 'KV Kim', data: { employedAmount: 390, bridgeMode: 'family', retiredMode: 'kvdr' }, linkedAccountId: null, linkedAccountBalance: null, sortOrder: 0 },
    { id: 109, personId: null, type: 'asset', label: 'Depot', data: { pot: 'depot', currentValue: 180000, returnRate: 0.05, monthlyContribution: 500 }, linkedAccountId: null, linkedAccountBalance: null, sortOrder: 0 },
    { id: 110, personId: null, type: 'asset', label: 'Tagesgeld', data: { pot: 'cash' }, linkedAccountId: 3, linkedAccountBalance: 42000, sortOrder: 0 },
    { id: 111, personId: null, type: 'living_expense', label: 'Lebenshaltung', data: { amount: 3400 }, linkedAccountId: null, linkedAccountBalance: null, sortOrder: 0 },
    { id: 112, personId: null, type: 'expense', label: 'Kredit Haus', data: { amount: 900, frequency: 'monthly', growthRate: 0, end: { kind: 'date', date: '2031-06-01' } }, linkedAccountId: null, linkedAccountBalance: null, sortOrder: 0 },
  ],
  scenarios: [
    { id: 1, name: 'Beide früh', config: { ...DEFAULT_SCENARIO, milestoneOverrides: { '11': { age: 59 }, '21': { age: 61 } } }, updatedAt: '2026-09-01T10:00:00Z' },
    { id: 2, name: 'Vorsichtig', config: { ...DEFAULT_SCENARIO, defaultReturnRate: 0.02, inflationRate: 0.03 }, updatedAt: '2026-09-02T10:00:00Z' },
  ],
  accounts: [
    { id: 3, label: 'Tagesgeld Beispielbank', balance: 42000 },
    { id: 4, label: 'Depot Beispielbank', balance: 180000 },
  ],
  defaultScenario: DEFAULT_SCENARIO,
}

/** A curve with the right shape, shifted by the leave ages the request carries. */
function toySimulation(req: ForecastSimulateRequest): ForecastSimulation {
  const startYear = 2026
  const endYear = 2068
  const overrides = req.scenario?.milestoneOverrides ?? {}
  const leaveA = 1970 + (overrides['11']?.age ?? 61)
  const leaveB = 1973 + (overrides['21']?.age ?? 63)
  const pensionA = 1970 + 66
  const pensionB = 1973 + 67
  let cash = 42000
  let depot = 180000
  let insurance = 38000
  const years: ForecastYearRow[] = []
  let failYear: number | null = null
  for (let year = startYear; year <= endYear; year++) {
    const income: Record<string, number> = {}
    const expenses: Record<string, number> = { 'item:111': 40800 * Math.pow(1.02, year - startYear) }
    if (year < leaveA) income['item:101'] = 38400 * Math.pow(1.02, year - startYear)
    if (year < leaveB) income['item:102'] = 33600 * Math.pow(1.02, year - startYear)
    if (year >= pensionA) income['item:103'] = 20400 * Math.pow(1.02, year - pensionA)
    if (year >= pensionB) income['item:104'] = 18000 * Math.pow(1.02, year - pensionB)
    if (year >= 2038) income['item:105'] = 4800
    if (year === 2032) income['item:106'] = 62000
    if (year <= 2031) expenses['item:112'] = 10800
    expenses['item:107'] = year < leaveA ? 5040 : year < pensionA ? 3600 : 4000
    if (year < leaveB) expenses['item:108'] = 4680
    if (year < 2032) expenses['contrib:106'] = 1800
    const totalIncome = Object.values(income).reduce((a, b) => a + b, 0)
    const totalExpenses = Object.values(expenses).reduce((a, b) => a + b, 0)
    const withdrawals: Record<string, number> = {}
    let net = totalIncome - totalExpenses
    depot *= 1.037
    if (year < 2032) insurance += 4000
    if (year === 2032) insurance = 0
    if (net >= 0) cash += net
    else {
      const fromCash = Math.min(cash, -net)
      cash -= fromCash
      net += fromCash
      if (fromCash) withdrawals.cash = fromCash
      if (net < 0) {
        const fromDepot = Math.min(depot, -net)
        depot -= fromDepot
        net += fromDepot
        if (fromDepot) withdrawals.depot = fromDepot
      }
      if (net < 0) cash += net
    }
    const liquid = cash + depot
    if (liquid < 0 && failYear === null) failYear = year
    years.push({
      year,
      ages: { '1': year - 1970, '2': year - 1973 },
      income,
      expenses,
      contributions: year < 2032 ? 1800 : 0,
      returns: depot * 0.037,
      taxes: depot * 0.01,
      withdrawals,
      pots: { cash, depot, insurance, real_estate: 0, other: 0 },
      wealthEnd: cash + depot + insurance,
      liquidEnd: liquid,
      totalIncome,
      totalExpenses,
      deficit: totalIncome < totalExpenses,
    })
  }
  const bridgeStart = Math.min(leaveA, leaveB)
  return {
    startYear,
    endYear,
    years,
    sources: [
      { key: 'item:101', label: 'Gehalt Alex', personId: 1, kind: 'salary' },
      { key: 'item:102', label: 'Gehalt Kim', personId: 2, kind: 'salary' },
      { key: 'item:103', label: 'Gesetzliche Rente Alex', personId: 1, kind: 'pension' },
      { key: 'item:104', label: 'Gesetzliche Rente Kim', personId: 2, kind: 'pension' },
      { key: 'item:105', label: 'Betriebsrente Kim', personId: 2, kind: 'pension' },
      { key: 'item:106', label: 'Lebensversicherung Alex', personId: 1, kind: 'life_insurance' },
      { key: 'contrib:106', label: 'Lebensversicherung Alex (Beitrag)', personId: 1, kind: 'life_insurance' },
      { key: 'item:107', label: 'KV Alex', personId: 1, kind: 'health_insurance' },
      { key: 'item:108', label: 'KV Kim', personId: 2, kind: 'health_insurance' },
      { key: 'item:111', label: 'Lebenshaltung', personId: null, kind: 'living_expense' },
      { key: 'item:112', label: 'Kredit Haus', personId: null, kind: 'expense' },
    ],
    pots: ['cash', 'depot', 'real_estate', 'other', 'insurance'],
    milestones: [
      { id: 11, personId: 1, kind: 'leave_work', label: 'Ausstieg aus dem Beruf', date: `${leaveA}-04-01`, year: leaveA, age: leaveA - 1970 },
      { id: 12, personId: 1, kind: 'statutory_pension', label: 'Gesetzliche Rente', date: `${pensionA}-04-01`, year: pensionA, age: 66 },
      { id: 13, personId: 1, kind: 'life_insurance_maturity', label: 'Ablauf Lebensversicherung', date: '2032-12-01', year: 2032, age: 62 },
      { id: 21, personId: 2, kind: 'leave_work', label: 'Ausstieg aus dem Beruf', date: `${leaveB}-09-01`, year: leaveB, age: leaveB - 1973 },
      { id: 22, personId: 2, kind: 'statutory_pension', label: 'Gesetzliche Rente', date: `${pensionB}-09-01`, year: pensionB, age: 67 },
      { id: 23, personId: 2, kind: 'company_pension', label: 'Betriebsrente', date: '2038-09-01', year: 2038, age: 65 },
    ],
    bridges: [
      { personId: 1, fromYear: leaveA, toYear: pensionA - 1, need: 95000, liquidAtStart: 260000, covered: true },
      { personId: 2, fromYear: leaveB, toYear: pensionB - 1, need: 120000, liquidAtStart: 190000, covered: true },
      { personId: null, fromYear: bridgeStart, toYear: pensionB - 1, need: 210000, liquidAtStart: 260000, covered: failYear === null },
    ],
    ok: failYear === null,
    failYear,
    potDryYear: { cash: failYear ? failYear - 1 : null, depot: failYear, real_estate: null, other: null, insurance: null },
    finalWealth: years[years.length - 1]?.wealthEnd ?? 0,
  }
}

function simulateHandler(req: ForecastSimulateRequest): ForecastSimulateResponse {
  const result = toySimulation(req)
  const matrix = req.matrix
    ? Array.from({ length: req.matrix.toAge - req.matrix.fromAge + 1 }, (_, i) => req.matrix!.fromAge + i).flatMap((ageA) =>
        Array.from({ length: req.matrix!.toAge - req.matrix!.fromAge + 1 }, (_, j) => req.matrix!.fromAge + j).map((ageB) => {
          const score = ageA + ageB - 122
          return { ageA, ageB, ok: score >= 0, finalWealth: Math.max(0, score) * 45000, failYear: score < 0 ? 2050 + score * 2 : null }
        }),
      )
    : null
  return {
    result,
    earliest: req.earliestFor != null ? { personId: req.earliestFor, age: req.earliestFor === 1 ? 60 : 62 } : null,
    matrix,
    comparisons: (req.compareScenarioIds ?? []).map((id) => {
      const s = BUNDLE.scenarios.find((x) => x.id === id)!
      return { scenarioId: id, name: s.name, result: toySimulation({ scenario: s.config }) }
    }),
  }
}

const handlers = [
  http.get('/api/finance/forecast', () => HttpResponse.json(BUNDLE)),
  http.get('/api/finance/forecast/statements', () => HttpResponse.json({ items: STATEMENTS })),
  http.post('/api/finance/forecast/simulate', async ({ request }) =>
    HttpResponse.json(simulateHandler((await request.json()) as ForecastSimulateRequest)),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof ForecastView> = {
  title: 'Views/Finance/ForecastView',
  component: ForecastView,
  decorators: [routeFromParameters('/finanzen/prognose')],
  parameters: { msw: { handlers } },
}

export default meta
type Story = StoryObj<typeof ForecastView>

export const ZweiPersonen: Story = { name: 'Zwei Personen' }

export const NochLeer: Story = {
  name: 'Noch keine Person',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/forecast', () =>
          HttpResponse.json({ ...BUNDLE, persons: [], milestones: [], items: [], scenarios: [] } satisfies ForecastBundle),
        ),
        ...handlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
