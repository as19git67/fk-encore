import type { Meta, StoryObj } from '@storybook/vue3'
import { h } from 'vue'
import { useRouter } from 'vue-router'
import RecapsView from '../views/RecapsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_PHOTOS } from './mock-data'

/**
 * The recap detail is a dialog in everything but name — a plain overlay over
 * the page. It is the case that showed the keyboard could not reach it
 * (issue #1281), so it has a story of its own: with the overlay open, focus
 * has to be inside it and Tab has to stay there.
 */

const RECAPS = [
  {
    id: 1,
    kind: 'on_this_day' as const,
    title: 'Heute vor drei Jahren',
    subtitle: 'Ein Tag am Wasser',
    cover_photo_id: MOCK_PHOTOS[0]?.id ?? 1,
    period_start: '2023-06-14',
    period_end: '2023-06-14',
    photo_count: 3,
    created_at: '2026-06-14T06:00:00.000Z',
    dismissed_at: null,
    seen_at: null,
  },
  {
    id: 2,
    kind: 'trip' as const,
    title: 'Wochenende in den Bergen',
    subtitle: null,
    cover_photo_id: MOCK_PHOTOS[1]?.id ?? 2,
    period_start: '2025-09-05',
    period_end: '2025-09-07',
    photo_count: 2,
    created_at: '2026-05-02T06:00:00.000Z',
    dismissed_at: null,
    seen_at: '2026-05-03T09:00:00.000Z',
  },
]

const recapHandlers = [
  http.get('/api/recaps', () => HttpResponse.json({ recaps: RECAPS })),
  http.get('/api/recaps-music', () => HttpResponse.json({ tracks: [] })),
  http.get('/api/recaps/:id', ({ params }) => {
    const recap = RECAPS.find((r) => String(r.id) === params.id) ?? RECAPS[0]!
    return HttpResponse.json({
      recap: { ...recap, seed: {}, photo_ids: MOCK_PHOTOS.slice(0, 3).map((p) => p.id) },
    })
  }),
  http.post('/api/recaps/:id/seen', () => HttpResponse.json({ seen: true })),
  ...defaultHandlers,
]

/** Puts the stub router on the view's own route, optionally with a query. */
function atRoute(target: string) {
  return (story: () => unknown) => ({
    setup() {
      const StoryComponent = story()
      const router = useRouter()
      if (router.currentRoute.value.fullPath !== target) {
        router.push(target).catch(() => {})
      }
      return () => h(StoryComponent as never)
    },
  })
}

const meta: Meta<typeof RecapsView> = {
  title: 'Views/RecapsView',
  component: RecapsView,
  decorators: [atRoute('/fotos/rueckblicke')],
  parameters: { msw: { handlers: recapHandlers } },
}

export default meta
type Story = StoryObj<typeof RecapsView>

export const MitRueckblicken: Story = {
  name: 'Mit Rückblicken',
}

export const LeereListe: Story = {
  name: 'Noch keine Rückblicke',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/recaps', () => HttpResponse.json({ recaps: [] })),
        ...recapHandlers,
      ],
    },
  },
}

/**
 * The detail open, which the view drives from `?id=` in the URL. The story
 * router starts at the view's own path, so the query goes on there.
 */
export const DetailOffen: Story = {
  name: 'Detail geöffnet',
  decorators: [atRoute('/fotos/rueckblicke?id=1')],
}
