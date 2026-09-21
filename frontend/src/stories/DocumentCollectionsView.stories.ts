import type { Meta, StoryObj } from '@storybook/vue3'
import DocumentCollectionsView from '../views/DocumentCollectionsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_COLLECTIONS } from './mock-data'
import { routeFromParameters } from './storyRoute'

/**
 * The Sammelmappen list (issue #1281). A folder whose summary is still being
 * written and one whose summary failed are the two states the list has to
 * distinguish without opening anything.
 */

const collectionHandlers = [
  http.get('/api/document-collections', () => HttpResponse.json({ items: MOCK_COLLECTIONS })),
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
        http.get('/api/document-collections', () => HttpResponse.json({ items: [] })),
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
        http.get('/api/document-collections', async () => {
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
        http.get('/api/document-collections', () =>
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
