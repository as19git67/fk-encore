import type { Meta, StoryObj } from '@storybook/vue3'
import TaxonomyCockpitView from '../views/TaxonomyCockpitView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { routeFromParameters } from './storyRoute'
import type { CockpitResponse } from '../api/taxonomy-cockpit'

/**
 * How well the classification is doing over time (issue #1281). Without a
 * single snapshot the page has nothing to draw — that is the state a new
 * installation is in, and it has to say what to do about it.
 */

const COCKPIT: CockpitResponse = {
  snapshots: [
    {
      snapshot_date: '2025-06-01',
      total_documents: 1240,
      classified_documents: 1190,
      sonstiges_count: 84,
      sonstiges_pct: 7.1,
      avg_confidence: 0.82,
      low_confidence_count: 61,
      teacher_requested_count: 12,
      open_suggestions_count: 3,
      category_count: 28,
    },
    {
      snapshot_date: '2025-05-01',
      total_documents: 1105,
      classified_documents: 1021,
      sonstiges_count: 112,
      sonstiges_pct: 11,
      avg_confidence: 0.76,
      low_confidence_count: 98,
      teacher_requested_count: 20,
      open_suggestions_count: 6,
      category_count: 26,
    },
  ],
  recommendations: [
    {
      severity: 'warning',
      action: 'Hinweise für „Sonstiges" schärfen',
      reason: 'Jedes vierzehnte Dokument landet weiterhin dort.',
    },
    {
      severity: 'info',
      action: 'Drei offene Kategorievorschläge entscheiden',
      reason: 'Sie warten seit über einer Woche.',
    },
  ],
}

const cockpitHandlers = [
  http.get('/api/admin/taxonomy-cockpit', () => HttpResponse.json(COCKPIT)),
  ...defaultHandlers,
]

const meta: Meta<typeof TaxonomyCockpitView> = {
  title: 'Views/TaxonomyCockpitView',
  component: TaxonomyCockpitView,
  decorators: [routeFromParameters('/dokumente/taxonomie-cockpit')],
  parameters: { msw: { handlers: cockpitHandlers } },
}

export default meta
type Story = StoryObj<typeof TaxonomyCockpitView>

export const MitMessungen: Story = { name: 'Mit Messungen' }

export const NochKeineMessung: Story = {
  name: 'Noch keine Messung',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/admin/taxonomy-cockpit', () =>
          HttpResponse.json({ snapshots: [], recommendations: [] }),
        ),
        ...cockpitHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/admin/taxonomy-cockpit', async () => {
          await delay('infinite')
          return HttpResponse.json(COCKPIT)
        }),
        ...cockpitHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/admin/taxonomy-cockpit', () =>
          HttpResponse.json({ message: 'Cockpit nicht erreichbar' }, { status: 500 }),
        ),
        ...cockpitHandlers,
      ],
    },
  },
}
