import type { Meta, StoryObj } from '@storybook/vue3'
import AnalysisView from '../views/finance/AnalysisView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_FINANCE_TAGS } from './finance-mock-data'
import { routeFromParameters } from './storyRoute'
import type { SavedAnalysisItem } from '../api/finance'

/**
 * Asking the finance data a question (issue #1281). What the page shows
 * before anything is asked is the saved analyses — so "none saved yet" and
 * "a shelf full of them" are the two states worth keeping.
 */

const SAVED: SavedAnalysisItem[] = [
  {
    id: 1,
    name: 'Lebensmittel pro Monat',
    question: 'Was gebe ich monatlich für Lebensmittel aus?',
    ast: { tags: ['Lebensmittel'], op: 'AND', kind: 'ongoing', interval: 'month' },
    source: 'user',
    summary: { sum: '-412.50', count: 38, avg: '-10.86' },
    seenAt: '2025-06-01T10:00:00.000Z',
    createdAt: '2025-05-02T10:00:00.000Z',
    updatedAt: '2025-06-01T10:00:00.000Z',
  },
  {
    id: 2,
    name: 'Urlaub Frühjahr',
    question: 'Was hat der Urlaub gekostet?',
    ast: {
      tags: ['Reise', 'Restaurant'],
      op: 'OR',
      kind: 'event',
      timespan: { from: '2025-03-01', to: '2025-03-31' },
    },
    source: 'ai',
    summary: { sum: '-1240.00', count: 17, avg: '-72.94' },
    seenAt: null,
    createdAt: '2025-04-03T10:00:00.000Z',
    updatedAt: '2025-04-03T10:00:00.000Z',
  },
]

const analysisHandlers = [
  http.get('/api/finance/tags', () => HttpResponse.json({ items: MOCK_FINANCE_TAGS })),
  http.post('/api/finance/saved-analysis/list', () =>
    HttpResponse.json({ items: SAVED, hasMore: false }),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof AnalysisView> = {
  title: 'Views/AnalysisView',
  component: AnalysisView,
  decorators: [routeFromParameters('/finanzen/analyse')],
  parameters: { msw: { handlers: analysisHandlers } },
}

export default meta
type Story = StoryObj<typeof AnalysisView>

export const MitGespeicherten: Story = { name: 'Mit gespeicherten Analysen' }

export const NochNichtsGespeichert: Story = {
  name: 'Noch nichts gespeichert',
  parameters: {
    msw: {
      handlers: [
        http.post('/api/finance/saved-analysis/list', () =>
          HttpResponse.json({ items: [], hasMore: false }),
        ),
        ...analysisHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.post('/api/finance/saved-analysis/list', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [], hasMore: false })
        }),
        ...analysisHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
