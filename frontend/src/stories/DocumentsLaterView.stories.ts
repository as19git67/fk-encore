import type { Meta, StoryObj } from '@storybook/vue3'
import DocumentsLaterView from '../views/DocumentsLaterView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_DOCUMENTS } from './mock-data'
import { routeFromParameters } from './storyRoute'

/**
 * Documents put off until a date (issue #1281). One is already due, one is
 * still in the future — the list has to make that difference visible.
 */

const FOLLOW_UPS = [
  {
    document: MOCK_DOCUMENTS[0]!,
    follow_up_date: '2025-05-01',
    note: 'Zählerstand nachtragen.',
    created_at: '2025-04-10T08:00:00.000Z',
  },
  {
    document: MOCK_DOCUMENTS[1]!,
    follow_up_date: '2099-01-15',
    note: null,
    created_at: '2025-04-11T08:00:00.000Z',
  },
]

const laterHandlers = [
  http.get('/api/documents/follow-ups', () => HttpResponse.json({ items: FOLLOW_UPS })),
  ...defaultHandlers,
]

const meta: Meta<typeof DocumentsLaterView> = {
  title: 'Views/DocumentsLaterView',
  component: DocumentsLaterView,
  decorators: [routeFromParameters('/dokumente/spaeter')],
  parameters: { msw: { handlers: laterHandlers } },
}

export default meta
type Story = StoryObj<typeof DocumentsLaterView>

export const MitWiedervorlagen: Story = { name: 'Mit Wiedervorlagen' }

export const NichtsGeplant: Story = {
  name: 'Nichts geplant',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/follow-ups', () => HttpResponse.json({ items: [] })),
        ...laterHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/follow-ups', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [] })
        }),
        ...laterHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
