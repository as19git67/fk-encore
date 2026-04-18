import type { Meta, StoryObj } from '@storybook/vue3'
import { h } from 'vue'
import { useRouter } from 'vue-router'
import AlbumDetailView from '../views/AlbumDetailView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_ALBUM_DETAIL } from './mock-data'

const meta: Meta<typeof AlbumDetailView> = {
  title: 'Views/AlbumDetailView',
  component: AlbumDetailView,
  decorators: [
    (story) => ({
      components: { Story: story() },
      setup() {
        const router = useRouter()
        if (router.currentRoute.value.path !== '/fotos/alben/1') {
          router.push('/fotos/alben/1').catch(() => {})
        }
        return () => h('Story')
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
      handlers: [
        http.get('/api/albums/:id', () =>
          HttpResponse.json({ ...MOCK_ALBUM_DETAIL, display_mode: 'grid' }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const KartenAnsicht: Story = {
  name: 'Album (Karte)',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/albums/:id', () =>
          HttpResponse.json({ ...MOCK_ALBUM_DETAIL, display_mode: 'map' }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const LeeresAlbum: Story = {
  name: 'Album ohne Fotos',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/albums/:id', () =>
          HttpResponse.json({ ...MOCK_ALBUM_DETAIL, photos: [], photo_count: 0 }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const BetrachterRolle: Story = {
  name: 'Album als Betrachter (read-only)',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/albums/:id', () =>
          HttpResponse.json({ ...MOCK_ALBUM_DETAIL, role: 'viewer' }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}
