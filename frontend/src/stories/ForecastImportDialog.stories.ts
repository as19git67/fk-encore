import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import ForecastImportDialog from '../components/finance/forecast/ForecastImportDialog.vue'
import { defaultHandlers } from './handlers'
import type { ForecastImportPreview, ForecastImportRaw } from '../api/finance'

/**
 * The spreadsheet import of the forecast (#1337) after a file was picked.
 * Every row is invented; the handler answers any file with this preview.
 */

const raw = (over: Partial<ForecastImportRaw>): ForecastImportRaw => ({
  amount: null,
  incomeYearly: null,
  expenseYearly: null,
  once: null,
  contributionUntilYear: null,
  payoutYear: null,
  note: null,
  detail: null,
  ...over,
})

const PREVIEW: ForecastImportPreview = {
  sheet: 'Liste',
  inflationRate: 0.03,
  pensionGrowthRate: 0.015,
  warnings: [],
  rows: [
    { row: 2, label: 'Bar Alex', raw: raw({ amount: 50000 }), suggestion: { type: 'asset', personId: 1, include: true, reason: null }, summary: '50.000 € (Konto)' },
    { row: 3, label: 'Einkommen Kim (netto)', raw: raw({ incomeYearly: 30000 }), suggestion: { type: 'salary', personId: 2, include: true, reason: null }, summary: '2.500 €/Monat netto' },
    { row: 4, label: 'Mieteinnahmen', raw: raw({ incomeYearly: 6000 }), suggestion: { type: 'income', personId: null, include: true, reason: null }, summary: '500 € pro Monat' },
    {
      row: 5,
      label: 'X-000111',
      raw: raw({ expenseYearly: -1200, once: 30000, contributionUntilYear: 2032, payoutYear: 2033 }),
      suggestion: { type: 'life_insurance', personId: 1, include: true, reason: null },
      summary: 'Beitrag 100 €/Monat bis 12/2032, Auszahlung 30.000 € 01/2033',
    },
    {
      row: 6,
      label: 'Y-000222',
      raw: raw({ expenseYearly: -900, once: 9000 }),
      suggestion: { type: 'life_insurance', personId: 1, include: false, reason: 'Ablaufjahr fehlt – bitte ergänzen' },
      summary: null,
    },
    { row: 7, label: 'Rente Alex', raw: raw({ incomeYearly: 18000, payoutYear: 2040 }), suggestion: { type: 'pension', personId: 1, include: true, reason: null }, summary: '1.500 €/Monat ab 01/2040' },
    {
      row: 8,
      label: 'Fondsausschüttung',
      raw: raw({ incomeYearly: 5000, payoutYear: 2020, note: 'Notiz aus der Tabelle' }),
      suggestion: { type: 'income', personId: null, include: true, reason: 'Auszahlungsjahr liegt in der Vergangenheit – bitte prüfen' },
      summary: '417 € pro Monat',
    },
    { row: 9, label: 'Nullvertrag', raw: raw({ expenseYearly: 0 }), suggestion: { type: null, personId: null, include: false, reason: 'Kein Betrag' }, summary: null },
    { row: 10, label: 'Leben', raw: raw({ expenseYearly: -24000 }), suggestion: { type: 'living_expense', personId: null, include: true, reason: null }, summary: '2.000 €/Monat' },
  ],
}

const handlers = [
  http.post('/api/finance/forecast/import/preview', () => HttpResponse.json(PREVIEW)),
  http.post('/api/finance/forecast/import/evaluate', () =>
    HttpResponse.json({ rows: [{ summary: 'Beitrag 75 €/Monat, Auszahlung 9.000 € 01/2040', error: null }] }),
  ),
  http.post('/api/finance/forecast/import/commit', () => HttpResponse.json({ created: 7 })),
  ...defaultHandlers,
]

const meta: Meta<typeof ForecastImportDialog> = {
  title: 'Components/Finance/ForecastImportDialog',
  component: ForecastImportDialog,
  args: {
    visible: true,
    persons: [
      { id: 1, label: 'Alex', birthDate: '1970-04-01', sortOrder: 0 },
      { id: 2, label: 'Kim', birthDate: '1973-09-01', sortOrder: 1 },
    ],
  },
  parameters: { msw: { handlers } },
}

export default meta
type Story = StoryObj<typeof ForecastImportDialog>

export const DateiWaehlen: Story = { name: 'Vor der Dateiauswahl' }

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
