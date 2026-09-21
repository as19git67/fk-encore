import type { Meta, StoryObj } from '@storybook/vue3'
import DocumentHintSuggestionsView from '../views/DocumentHintSuggestionsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { routeFromParameters } from './storyRoute'
import type { HintSuggestion } from '../api/documents'

/**
 * Drafted classification hints waiting for a yes or no (issue #1281).
 */

const SUGGESTIONS: HintSuggestion[] = [
  {
    id: 1,
    kind: 'tax-section',
    target_slug: 'handwerkerleistungen',
    draft_hint: 'Rechnungen über Arbeitslohn im Haushalt gehören hierher, Material nicht.',
    rationale: 'Drei Belege wurden zuletzt von Hand umsortiert.',
    example_document_ids: [1, 2, 3],
    status: 'open',
    created_at: '2025-06-01T08:00:00.000Z',
    updated_at: '2025-06-01T08:00:00.000Z',
  },
  {
    id: 2,
    kind: 'category',
    target_slug: 'versicherung',
    draft_hint: 'Auch Beitragsrechnungen und Nachträge, nicht nur Policen.',
    rationale: null,
    example_document_ids: [4],
    status: 'open',
    created_at: '2025-06-02T08:00:00.000Z',
    updated_at: '2025-06-02T08:00:00.000Z',
  },
]

const hintHandlers = [
  http.get('/api/document-hint-suggestions', () => HttpResponse.json({ items: SUGGESTIONS })),
  ...defaultHandlers,
]

const meta: Meta<typeof DocumentHintSuggestionsView> = {
  title: 'Views/DocumentHintSuggestionsView',
  component: DocumentHintSuggestionsView,
  decorators: [routeFromParameters('/dokumente/hint-vorschlaege')],
  parameters: { msw: { handlers: hintHandlers } },
}

export default meta
type Story = StoryObj<typeof DocumentHintSuggestionsView>

export const OffeneVorschlaege: Story = { name: 'Offene Vorschläge' }

export const NichtsOffen: Story = {
  name: 'Nichts offen',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/document-hint-suggestions', () => HttpResponse.json({ items: [] })),
        ...hintHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/document-hint-suggestions', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [] })
        }),
        ...hintHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
