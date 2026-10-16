import type { Meta, StoryObj } from '@storybook/vue3'
import { h } from 'vue'
import { useRouter } from 'vue-router'
import { http, HttpResponse } from 'msw'
import SharedCollectionView from '../views/SharedCollectionView.vue'
import { defaultHandlers, placeholderSvg } from './handlers'
import type { PublicCollection } from '../api/collections'

/** A collection behind an anonymous share link (#1548, stage 8). */

const COLLECTION: PublicCollection = {
  title: 'Sommerurlaub',
  description: 'Die schönsten Bilder und die Unterlagen zur Reise.',
  expires_at: '2026-11-15T08:00:00Z',
  photos: [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, taken_on: '2026-07-0' + ((id % 9) + 1) })),
  albums: [{ id: 3, title: 'Wanderung', photo_ids: [5, 6, 7, 8] }],
  documents: [
    { id: 11, title: 'Reiseplan', date: '2026-06-20', mime_type: 'application/pdf' },
    { id: 12, title: 'Buchungsbestätigung Ferienwohnung Musterstadt', date: null, mime_type: 'application/pdf' },
  ],
  withheld: [{ kind: 'Buchungen', count: 3 }],
}

const photoHandler = http.get('/api/collections/public/:token/photos/:photoId', ({ params }) =>
  new HttpResponse(placeholderSvg(`foto-${params.photoId as string}`), { headers: { 'Content-Type': 'image/svg+xml' } }),
)

const meta: Meta<typeof SharedCollectionView> = {
  title: 'Views/SharedCollectionView',
  component: SharedCollectionView,
  decorators: [
    (story) => ({
      setup() {
        const StoryComponent = story()
        const router = useRouter()
        const target = '/geteilt/beispielTokenAbc0123456789xyz'
        if (router.currentRoute.value.fullPath !== target) router.push(target).catch(() => {})
        return () => h(StoryComponent)
      },
    }),
  ],
}

export default meta
type Story = StoryObj<typeof SharedCollectionView>

export const Geteilt: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get('/api/collections/public/:token', () => HttpResponse.json(COLLECTION)),
        photoHandler,
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
        http.get('/api/collections/public/:token', () =>
          HttpResponse.json({ code: 'not_found', message: 'link not found' }, { status: 404 }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}
