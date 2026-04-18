import type { Meta, StoryObj } from '@storybook/vue3'
import { h } from 'vue'
import { useRouter } from 'vue-router'
import SharedAlbumView from '../views/SharedAlbumView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_PUBLIC_ALBUM } from './mock-data'

const meta: Meta<typeof SharedAlbumView> = {
  title: 'Views/SharedAlbumView',
  component: SharedAlbumView,
  decorators: [
    (story) => ({
      components: { Story: story() },
      setup() {
        const router = useRouter()
        const target = '/albums/shared/abcd1234ef567890'
        if (router.currentRoute.value.fullPath !== target) {
          router.push(target).catch(() => {})
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
type Story = StoryObj<typeof SharedAlbumView>

export const KartenAnsicht: Story = {
  name: 'Geteiltes Album (Karte)',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/albums/public/:token', () =>
          HttpResponse.json({ ...MOCK_PUBLIC_ALBUM, display_mode: 'map' }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const RasterAnsicht: Story = {
  name: 'Geteiltes Album (Raster)',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/albums/public/:token', () =>
          HttpResponse.json({ ...MOCK_PUBLIC_ALBUM, display_mode: 'grid' }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const LinkUngueltig: Story = {
  name: 'Link ungültig',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/albums/public/:token', () =>
          HttpResponse.json(
            { code: 'not_found', message: 'Album nicht gefunden oder Link abgelaufen.' },
            { status: 404 },
          ),
        ),
        ...defaultHandlers,
      ],
    },
  },
}
