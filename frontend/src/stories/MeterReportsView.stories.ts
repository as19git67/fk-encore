import type { Meta, StoryObj } from '@storybook/vue3'
import MeterReportsView from '../views/MeterReportsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_METERS } from './mock-data'
import { routeFromParameters } from './storyRoute'

/**
 * The meter reports (issue #1281). Every figure here needs readings and a
 * tariff to exist, so the page spends most of its life saying what is still
 * missing — that state is the one worth pinning down.
 */

const EMPTY_ENERGY = {
  unit: 'kWh',
  decimals: 1,
  granularity: 'month',
  allocation: 'interpolated',
  from: null,
  to: null,
  meters: [],
  missingRoles: ['grid_import', 'pv_production'],
  duplicateRoles: [],
  buckets: [],
  totals: {
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
  },
  hasTariffs: false,
}

const reportHandlers = [
  http.get('/api/meters', () => HttpResponse.json({ meters: MOCK_METERS })),
  http.get('/api/meters/reports/energy', () => HttpResponse.json(EMPTY_ENERGY)),
  http.get('/api/meters/reports/trends', () =>
    HttpResponse.json({ generatedAt: '2025-06-01T00:00:00.000Z', trends: [] }),
  ),
  http.get('/api/meters/reports/economics', () =>
    HttpResponse.json({
      granularity: 'month',
      currency: 'EUR',
      from: null,
      to: null,
      hasTariffs: false,
      hasInvestmentData: false,
      pv: {
        buckets: [],
        totalSavingsEur: null,
        totalPvBenefitEur: null,
        totalSelfConsumptionVatEur: null,
        totalNetElectricityCostEur: null,
        totalNoPvElectricityCostEur: null,
        amortization: null,
      },
      usageCosts: { buckets: [], totals: {} },
      water: [],
    }),
  ),
  http.get('/api/meters/reports/comparisons', () =>
    HttpResponse.json({
      granularity: 'month',
      currency: 'EUR',
      from: null,
      to: null,
      hasHeatingAssumptions: false,
      hasCarAssumptions: false,
      heating: null,
      car: null,
    }),
  ),
  http.get('/api/meters/reports/equipment', () =>
    HttpResponse.json({
      granularity: 'month',
      from: null,
      to: null,
      operatingHours: [],
      compressorEfficiency: null,
      waterBaselines: [],
      pvYield: null,
      missingRoles: [],
      duplicateRoles: [],
    }),
  ),
  http.get('/api/meters/reports/season-profile', () =>
    HttpResponse.json({ metrics: [], monthsMeasured: 0 }),
  ),
  http.get('/api/meters/reports/heating-weather', () =>
    HttpResponse.json({
      meterId: null, meterName: null, unit: 'kWh', source: null, degreeDayMonths: 0,
      normalDegreeDays: [], typicalKwh: [], referenceYears: 0, buckets: [], years: [],
      latestKwhPerDegreeDay: null, previousKwhPerDegreeDay: null, changePercent: null,
      slopePerYear: null,
    }),
  ),
  http.get('/api/meters/reports/advance-payments', () =>
    HttpResponse.json({ currency: 'EUR', meters: [] }),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof MeterReportsView> = {
  title: 'Views/MeterReportsView',
  component: MeterReportsView,
  decorators: [routeFromParameters('/zaehler/auswertungen')],
  parameters: { msw: { handlers: reportHandlers } },
}

export default meta
type Story = StoryObj<typeof MeterReportsView>

export const NochKeineZahlen: Story = { name: 'Zähler ohne Zahlen' }

export const OhneZaehler: Story = {
  name: 'Ohne Zähler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/meters', () => HttpResponse.json({ meters: [] })),
        ...reportHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/meters', async () => {
          await delay('infinite')
          return HttpResponse.json({ meters: [] })
        }),
        ...reportHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/meters', () =>
          HttpResponse.json({ message: 'Zähler nicht erreichbar' }, { status: 500 }),
        ),
        ...reportHandlers,
      ],
    },
  },
}
