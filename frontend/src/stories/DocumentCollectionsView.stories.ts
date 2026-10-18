import type { Meta, StoryObj } from '@storybook/vue3'
import DocumentCollectionsView from '../views/DocumentCollectionsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_COLLECTIONS, toCollectionSummary } from './mock-data'
import { routeFromParameters } from './storyRoute'

/**
 * The Sammelmappen list of the documents module (issue #1281): the same
 * tiles and menu as the Sammelmappen page, read from the shared collection
 * list.
 */

const collectionHandlers = [
  http.get('/api/collections', () => HttpResponse.json({ items: MOCK_COLLECTIONS.map(toCollectionSummary) })),
  ...defaultHandlers,
]

const meta: Meta<typeof DocumentCollectionsView> = {
  title: 'Views/DocumentCollectionsView',
  component: DocumentCollectionsView,
  decorators: [routeFromParameters('/dokumente/mappen')],
  parameters: { msw: { handlers: collectionHandlers } },
}

export default meta
type Story = StoryObj<typeof DocumentCollectionsView>

export const MitMappen: Story = { name: 'Mit Mappen' }

export const NochKeine: Story = {
  name: 'Noch keine Mappe',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/collections', () => HttpResponse.json({ items: [] })),
        ...collectionHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/collections', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [] })
        }),
        ...collectionHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/collections', () =>
          HttpResponse.json({ message: 'Mappen nicht erreichbar' }, { status: 500 }),
        ),
        ...collectionHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
