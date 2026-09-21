import type { Meta, StoryObj } from '@storybook/vue3'
import DocumentCategorySuggestionsView from '../views/DocumentCategorySuggestionsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { routeFromParameters } from './storyRoute'
import type { CategorySuggestion } from '../api/documents'

/**
 * Categories the classifier would like to add (issue #1281). Nothing open is
 * the resting state; the list only fills after a run found something.
 */

const SUGGESTIONS: CategorySuggestion[] = [
  {
    id: 1,
    suggested_name: 'Kfz-Versicherung',
    parent_slug: 'versicherung',
    example_document_ids: [1, 2],
    rationale: 'Vier Dokumente handeln von der Fahrzeugversicherung und passen in keine Kategorie.',
    status: 'open',
    created_at: '2025-06-01T08:00:00.000Z',
  },
  {
    id: 2,
    suggested_name: 'Gartenpflege',
    parent_slug: null,
    example_document_ids: [3],
    rationale: null,
    status: 'open',
    created_at: '2025-06-02T08:00:00.000Z',
  },
]

const suggestionHandlers = [
  http.get('/api/document-category-suggestions', () => HttpResponse.json({ items: SUGGESTIONS })),
  ...defaultHandlers,
]

const meta: Meta<typeof DocumentCategorySuggestionsView> = {
  title: 'Views/DocumentCategorySuggestionsView',
  component: DocumentCategorySuggestionsView,
  decorators: [routeFromParameters('/dokumente/kategorien/vorschlaege')],
  parameters: { msw: { handlers: suggestionHandlers } },
}

export default meta
type Story = StoryObj<typeof DocumentCategorySuggestionsView>

export const OffeneVorschlaege: Story = { name: 'Offene Vorschläge' }

export const NichtsOffen: Story = {
  name: 'Nichts offen',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/document-category-suggestions', () => HttpResponse.json({ items: [] })),
        ...suggestionHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/document-category-suggestions', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [] })
        }),
        ...suggestionHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/document-category-suggestions', () =>
          HttpResponse.json({ message: 'Vorschläge nicht erreichbar' }, { status: 500 }),
        ),
        ...suggestionHandlers,
      ],
    },
  },
}
