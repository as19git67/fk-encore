import type { Meta, StoryObj } from '@storybook/vue3'
import GalleryView from '../views/GalleryView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_PHOTOS } from './mock-data'
import { routeFromParameters } from './storyRoute'

/**
 * The photo gallery (issue #1281) — the view the whole unification started
 * from. Its states: photos, a filter that matched nothing, an empty
 * library, the first load, and a load that failed.
 */

const galleryHandlers = [
  http.get('/api/photos/index', () => HttpResponse.json({ photos: MOCK_PHOTOS })),
  ...defaultHandlers,
]

const meta: Meta<typeof GalleryView> = {
  title: 'Views/GalleryView',
  component: GalleryView,
  decorators: [routeFromParameters('/fotos/galerie')],
  parameters: { msw: { handlers: galleryHandlers } },
}

export default meta
type Story = StoryObj<typeof GalleryView>

export const MitFotos: Story = { name: 'Mit Fotos' }

export const NochKeineFotos: Story = {
  name: 'Noch keine Fotos',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos/index', () => HttpResponse.json({ photos: [] })),
        ...galleryHandlers,
      ],
    },
  },
}

export const SucheOhneTreffer: Story = {
  name: 'Suche ohne Treffer',
  parameters: {
    route: '/fotos/galerie?q=gibtsnicht',
    msw: {
      handlers: [
        http.get('/api/photos/index', () => HttpResponse.json({ photos: [] })),
        ...galleryHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos/index', async () => {
          await delay('infinite')
          return HttpResponse.json({ photos: [] })
        }),
        ...galleryHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos/index', () =>
          HttpResponse.json({ message: 'Fotos nicht erreichbar' }, { status: 500 }),
        ),
        ...galleryHandlers,
      ],
    },
  },
}
