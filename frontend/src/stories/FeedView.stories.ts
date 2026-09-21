import type { Meta, StoryObj } from '@storybook/vue3'
import FeedView from '../views/FeedView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { routeFromParameters } from './storyRoute'
import type { FeedItem } from '../api/feed'

/**
 * What happened in the shared albums (issue #1281). Nothing yet is the
 * state of a fresh account and of anyone who shares with nobody.
 */

const ITEMS: FeedItem[] = [
  {
    id: 3,
    kind: 'photo_commented',
    actor: { id: 2, name: 'Alex Beispiel' },
    album: { id: 1, name: 'Wanderung' },
    photo: { id: 1, filename: 'castle.jpg', description: null },
    payload: { comment: 'Das Licht!' },
    seen_at: null,
    created_at: '2026-09-20T18:20:00.000Z',
  },
  {
    id: 2,
    kind: 'album_shared',
    actor: { id: 3, name: 'Kim Beispiel' },
    album: { id: 2, name: 'Garten' },
    photo: null,
    payload: {},
    seen_at: '2026-09-20T09:00:00.000Z',
    created_at: '2026-09-19T17:00:00.000Z',
  },
  {
    id: 1,
    kind: 'photo_added',
    actor: { id: 2, name: 'Alex Beispiel' },
    album: { id: 1, name: 'Wanderung' },
    photo: { id: 4, filename: 'seagull.jpg', description: null },
    payload: { count: 6 },
    seen_at: '2026-09-19T08:00:00.000Z',
    created_at: '2026-09-18T15:30:00.000Z',
  },
]

const feedHandlers = [
  http.get('/api/feed', () =>
    HttpResponse.json({ items: ITEMS, nextCursor: null, unreadCount: 1 }),
  ),
  http.post('/api/feed/seen', () => HttpResponse.json({ ok: true })),
  ...defaultHandlers,
]

const meta: Meta<typeof FeedView> = {
  title: 'Views/FeedView',
  component: FeedView,
  decorators: [routeFromParameters('/fotos/feed')],
  parameters: { msw: { handlers: feedHandlers } },
}

export default meta
type Story = StoryObj<typeof FeedView>

export const MitEreignissen: Story = { name: 'Mit Ereignissen' }

export const NochNichts: Story = {
  name: 'Noch nichts passiert',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/feed', () =>
          HttpResponse.json({ items: [], nextCursor: null, unreadCount: 0 }),
        ),
        ...feedHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/feed', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [], nextCursor: null, unreadCount: 0 })
        }),
        ...feedHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
