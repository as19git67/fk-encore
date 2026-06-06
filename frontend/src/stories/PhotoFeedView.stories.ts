import type { Meta, StoryObj } from '@storybook/vue3'
import PhotoFeedView from '../views/PhotoFeedView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import type { FeedPhotoItem } from '../api/photoFeed'

const MOCK_ITEMS: FeedPhotoItem[] = [
  {
    photoId: 1,
    filename: 'strand-sonnenuntergang.jpg',
    width: 1600,
    height: 1200,
    description: 'Sonnenuntergang am Strand – der letzte Abend im Urlaub.',
    takenAt: '2026-05-30T18:42:00.000Z',
    lastActivityAt: '2026-06-05T09:10:00.000Z',
    album: { id: 7, name: 'Urlaub 2026' },
    owner: { id: 2, name: 'Anna Müller' },
    likeCount: 3,
    likedByMe: true,
    commentCount: 2,
    latestComment: { author: 'Tom', excerpt: 'Wahnsinns Farben!' },
  },
  {
    photoId: 2,
    filename: 'geburtstag-torte.jpg',
    width: 1200,
    height: 1500,
    description: null,
    takenAt: '2026-06-01T15:00:00.000Z',
    lastActivityAt: '2026-06-04T20:05:00.000Z',
    album: { id: 9, name: 'Lottas Geburtstag' },
    owner: { id: 3, name: 'Tom Schmidt' },
    likeCount: 1,
    likedByMe: false,
    commentCount: 0,
    latestComment: null,
  },
  {
    photoId: 3,
    filename: 'wanderung-gipfel.jpg',
    width: 1600,
    height: 1067,
    description: 'Oben angekommen 🏔️',
    takenAt: '2026-05-20T11:20:00.000Z',
    lastActivityAt: '2026-06-03T08:00:00.000Z',
    album: { id: 7, name: 'Urlaub 2026' },
    owner: { id: 2, name: 'Anna Müller' },
    likeCount: 5,
    likedByMe: false,
    commentCount: 4,
    latestComment: { author: 'Opa', excerpt: 'Da war ich vor 40 Jahren auch!' },
  },
]

const feedHandlers = [
  http.get('/api/feed/photos', () =>
    HttpResponse.json({ items: MOCK_ITEMS, nextCursor: null }),
  ),
  http.patch('/api/photos/:id/curation', () => HttpResponse.json({ success: true })),
  http.patch('/api/photos/:id/description', async ({ request }) => {
    const body = (await request.json()) as { description: string | null }
    return HttpResponse.json({ success: true, description: body.description })
  }),
  http.get('/api/photos/:id/locations', ({ params }) =>
    HttpResponse.json({
      photoId: Number(params.id),
      albums: [
        { id: 7, name: 'Urlaub 2026' },
        { id: 9, name: 'Lottas Geburtstag' },
      ],
      persons: [],
      hasGps: false,
    }),
  ),
  http.post('/api/photos/:id/comments', () =>
    HttpResponse.json({
      id: 99,
      photoId: 1,
      albumId: 7,
      author: { id: 1, name: 'Du', kind: 'user' },
      body: 'Schön!',
      createdAt: new Date().toISOString(),
      editedAt: null,
    }),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof PhotoFeedView> = {
  title: 'Views/PhotoFeedView',
  component: PhotoFeedView,
  parameters: {
    msw: { handlers: feedHandlers },
  },
}

export default meta
type Story = StoryObj<typeof PhotoFeedView>

export const MitBeitraegen: Story = {
  name: 'Content-Feed',
}

export const Leer: Story = {
  name: 'Keine Beiträge',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/feed/photos', () =>
          HttpResponse.json({ items: [], nextCursor: null }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}
