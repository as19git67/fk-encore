import type { Meta, StoryObj } from '@storybook/vue3'
import MeterAnomaliesView from '../views/MeterAnomaliesView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { routeFromParameters } from './storyRoute'
import type { MeterAnomalyItem } from '../api/meters'

/**
 * What the meter watch flagged (issue #1281): a jump in consumption, a
 * reading that never came. Nothing pending is the good state and says so.
 */

const ANOMALIES: MeterAnomalyItem[] = [
  {
    id: 1,
    meterId: 1,
    meterName: 'Strom Haus',
    meterType: 'electricity',
    unit: 'kWh',
    decimals: 1,
    type: 'consumption_spike',
    status: 'pending',
    score: 0.88,
    intervalStart: '2025-05-01',
    intervalEnd: '2025-05-31',
    readingId: 42,
    details: { expected: 210, measured: 480 },
    message: 'Der Verbrauch liegt mehr als doppelt so hoch wie in den Vormonaten.',
    createdAt: '2025-06-01T06:00:00.000Z',
    resolvedAt: null,
  },
  {
    id: 2,
    meterId: 2,
    meterName: 'Wasser Garten',
    meterType: 'water',
    unit: 'm³',
    decimals: 3,
    type: 'standstill',
    status: 'pending',
    score: null,
    intervalStart: '2025-05-01',
    intervalEnd: '2025-05-31',
    readingId: null,
    details: {},
    message: 'Der Zähler steht seit zwei Monaten still.',
    createdAt: '2025-06-01T06:00:00.000Z',
    resolvedAt: null,
  },
]

const anomalyHandlers = [
  http.get('/api/meters/anomalies', () =>
    HttpResponse.json({ anomalies: ANOMALIES, total: ANOMALIES.length }),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof MeterAnomaliesView> = {
  title: 'Views/MeterAnomaliesView',
  component: MeterAnomaliesView,
  decorators: [routeFromParameters('/zaehler/auffaelligkeiten')],
  parameters: { msw: { handlers: anomalyHandlers } },
}

export default meta
type Story = StoryObj<typeof MeterAnomaliesView>

export const MitAuffaelligkeiten: Story = { name: 'Mit Auffälligkeiten' }

export const NichtsOffen: Story = {
  name: 'Nichts offen',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/meters/anomalies', () => HttpResponse.json({ anomalies: [], total: 0 })),
        ...anomalyHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/meters/anomalies', async () => {
          await delay('infinite')
          return HttpResponse.json({ anomalies: [], total: 0 })
        }),
        ...anomalyHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
