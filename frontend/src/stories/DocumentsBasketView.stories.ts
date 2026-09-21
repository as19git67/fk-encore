import type { Meta, StoryObj } from '@storybook/vue3'
import DocumentsBasketView from '../views/DocumentsBasketView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_DOCUMENTS } from './mock-data'
import { routeFromParameters } from './storyRoute'

/**
 * The documents work basket (issue #1281): what still wants looking at. An
 * empty basket is the goal, not a defect, and the page says so.
 */

const basketHandlers = [
  http.get('/api/documents/basket', () =>
    HttpResponse.json({ items: MOCK_DOCUMENTS, total: MOCK_DOCUMENTS.length }),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof DocumentsBasketView> = {
  title: 'Views/DocumentsBasketView',
  component: DocumentsBasketView,
  decorators: [routeFromParameters('/dokumente/korb')],
  parameters: { msw: { handlers: basketHandlers } },
}

export default meta
type Story = StoryObj<typeof DocumentsBasketView>

export const MitDokumenten: Story = { name: 'Mit Dokumenten' }

export const KorbLeer: Story = {
  name: 'Korb leer',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/basket', () => HttpResponse.json({ items: [], total: 0 })),
        ...basketHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/basket', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [], total: 0 })
        }),
        ...basketHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/basket', () =>
          HttpResponse.json({ message: 'Korb nicht erreichbar' }, { status: 500 }),
        ),
        ...basketHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
