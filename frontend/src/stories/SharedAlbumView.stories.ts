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
    (story, ctx) => ({
      components: { Story: story() },
      setup() {
        const router = useRouter()
        // A story can request a deep-link target (e.g. `?photoId=1`) to
        // open the fullscreen overlay straight away. Falls back to the
        // plain album route.
        const target =
          (ctx.parameters?.routeTarget as string | undefined) ??
          '/albums/shared/abcd1234ef567890'
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

/**
 * Guest endpoints the fullscreen details panel hits on open:
 * the guest-session probe and the per-photo comment thread. Both return
 * empty/anonymous so the panel renders its read-only state without
 * unhandled-request noise.
 */
const guestHandlers = [
  http.get('/api/share/:token/guests/me', () => HttpResponse.json({ guest: null })),
  http.get('/api/share/:token/photos/:photoId/comments', () =>
    HttpResponse.json({ comments: [] }),
  ),
]

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

/**
 * Fullscreen split view (photo + details) of a link-opened album. Deep-
 * links into `?photoId=1`, which opens the overlay with the details panel
 * active — the same FullscreenOverlay split layout the signed-in
 * AlbumDetailView uses. Pinned to a landscape viewport so the screenshot
 * shows the side-by-side photo/metadata arrangement (photo left, info +
 * mini-map right).
 */
export const VollbildSplit: Story = {
  name: 'Vollbild Split (Foto + Details)',
  parameters: {
    routeTarget: '/albums/shared/abcd1234ef567890?photoId=1',
    testViewport: { width: 1280, height: 720 },
    msw: {
      handlers: [
        http.get('/api/albums/public/:token', () =>
          HttpResponse.json({ ...MOCK_PUBLIC_ALBUM, display_mode: 'grid' }),
        ),
        ...guestHandlers,
        ...defaultHandlers,
      ],
    },
  },
}

/**
 * Same split view in portrait orientation, where the layout stacks the
 * photo on top and the metadata below.
 */
export const VollbildSplitPortrait: Story = {
  name: 'Vollbild Split (Hochformat)',
  parameters: {
    routeTarget: '/albums/shared/abcd1234ef567890?photoId=1',
    testViewport: { width: 430, height: 900 },
    msw: {
      handlers: [
        http.get('/api/albums/public/:token', () =>
          HttpResponse.json({ ...MOCK_PUBLIC_ALBUM, display_mode: 'grid' }),
        ),
        ...guestHandlers,
        ...defaultHandlers,
      ],
    },
  },
}
