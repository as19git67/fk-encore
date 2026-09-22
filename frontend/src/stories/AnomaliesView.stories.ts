import type { Meta, StoryObj } from '@storybook/vue3'
import AnomaliesView from '../views/finance/AnomaliesView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_ANOMALIES } from './finance-mock-data'
import { routeFromParameters } from './storyRoute'

/**
 * What the anomaly detector found, in each state (issue #1281). The empty
 * state is the good news here — nothing to acknowledge — and it reads
 * differently once a filter is what emptied the list.
 */

const anomalyHandlers = [
  http.get('/api/finance/anomalies', () =>
    HttpResponse.json({ anomalies: MOCK_ANOMALIES, total: MOCK_ANOMALIES.length }),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof AnomaliesView> = {
  title: 'Views/AnomaliesView',
  component: AnomaliesView,
  decorators: [routeFromParameters('/finanzen/anomalien')],
  parameters: { msw: { handlers: anomalyHandlers } },
}

export default meta
type Story = StoryObj<typeof AnomaliesView>

export const MitAnomalien: Story = { name: 'Mit Anomalien' }

export const NichtsZuTun: Story = {
  name: 'Nichts zu quittieren',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/anomalies', () => HttpResponse.json({ anomalies: [], total: 0 })),
        ...anomalyHandlers,
      ],
    },
  },
}

export const GefiltertLeer: Story = {
  name: 'Filter ohne Treffer',
  parameters: {
    route: '/finanzen/anomalien?type=duplicate',
    msw: {
      handlers: [
        http.get('/api/finance/anomalies', () =>
          HttpResponse.json({ anomalies: [MOCK_ANOMALIES[0]!], total: 1 }),
        ),
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
        http.get('/api/finance/anomalies', async () => {
          await delay('infinite')
          return HttpResponse.json({ anomalies: [], total: 0 })
        }),
        ...anomalyHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/anomalies', () => HttpResponse.json({}, { status: 500 })),
        ...anomalyHandlers,
      ],
    },
  },
}
