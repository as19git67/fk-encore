import type { Meta, StoryObj } from '@storybook/vue3'
import { h } from 'vue'
import { useRouter } from 'vue-router'
import AlbumDetailView from '../views/AlbumDetailView.vue'
import { albumDetail, defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_ALBUM_PHOTOS } from './mock-data'

/**
 * The album endpoint, answering metadata-only and full requests the way the
 * backend does — the view asks for both.
 */
function albumHandlers(overrides: Record<string, unknown> = {}, photos = MOCK_ALBUM_PHOTOS) {
  return [
    http.get('/api/albums/:id/photos', () => HttpResponse.json({ photos })),
    http.get('/api/albums/:id', ({ request }) =>
      HttpResponse.json(albumDetail(request, overrides)),
    ),
    ...defaultHandlers,
  ]
}

const meta: Meta<typeof AlbumDetailView> = {
  title: 'Views/AlbumDetailView',
  component: AlbumDetailView,
  decorators: [
    (story) => ({
      setup() {
        const StoryComponent = story()
        const router = useRouter()
        if (router.currentRoute.value.path !== '/fotos/alben/1') {
          router.push('/fotos/alben/1').catch(() => {})
        }
        return () => h(StoryComponent)
      },
    }),
  ],
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof AlbumDetailView>

export const RasterAnsicht: Story = {
  name: 'Album (Raster)',
  parameters: {
    msw: {
      handlers: albumHandlers({ display_mode: 'grid' }),
    },
  },
}

export const KartenAnsicht: Story = {
  name: 'Album (Karte)',
  parameters: {
    msw: {
      handlers: albumHandlers({ display_mode: 'map' }),
    },
  },
}

export const LeeresAlbum: Story = {
  name: 'Album ohne Fotos',
  parameters: {
    msw: {
      handlers: albumHandlers({ photos: [], photo_count: 0 }, []),
    },
  },
}

export const BetrachterRolle: Story = {
  name: 'Album als Betrachter (read-only)',
  parameters: {
    msw: {
      handlers: albumHandlers({ role: 'viewer' }),
    },
  },
}

export const FotosKommenNach: Story = {
  name: 'Album, dessen Foto-Array nie ankommt',
  parameters: {
    // The album reports its photos, but the background hydration fails. The
    // grid must still render — it loads from the gallery endpoint and never
    // needed that array. Showing "no photos yet" here is the bug this story
    // guards against.
    msw: {
      handlers: [
        http.get('/api/albums/:id/photos', () => HttpResponse.json({ error: 'kaputt' }, { status: 500 })),
        ...albumHandlers({ display_mode: 'grid', photo_count: MOCK_ALBUM_PHOTOS.length }),
      ],
    },
  },
}
