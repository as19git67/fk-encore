import type { Meta, StoryObj } from '@storybook/vue3'
import ReviewQueueView from '../views/ReviewQueueView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { routeFromParameters } from './storyRoute'
import type { ReviewQueueResponse } from '../api/photos'

/**
 * Groups of near-identical photos waiting for a decision (issue #1281).
 * A queue that has run dry is the state to aim for, and the page says so
 * rather than showing an empty strip.
 */

const QUEUE: ReviewQueueResponse = {
  total: 2,
  high_confidence_total: 1,
  offset: 0,
  groups: [
    {
      id: 1,
      cover_photo_id: 1,
      member_count: 3,
      ai_picked_photo_ids: [1],
      ai_picked_confidence: 'high',
      runner_up_delta: 0.21,
      duplicate_candidate: false,
      duplicate_recommended_photo_id: null,
      duplicate_deletable_count: 0,
      duplicate_deletable_bytes: 0,
      orientation_pair: false,
      photos: [
        {
          id: 1, filename: 'castle.jpg', taken_at: '2025-04-01T10:00:00.000Z',
          curation: 'visible', ai_picked: true, ai_quality_score: 0.88,
          width: 4000, height: 3000,
          peer_curation: { hidden: 0, favorite: 1 },
        },
        {
          id: 2, filename: 'fish.jpg', taken_at: '2025-04-01T10:00:02.000Z',
          curation: 'visible', ai_picked: false, ai_quality_score: 0.67,
          width: 4000, height: 3000,
          peer_curation: { hidden: 0, favorite: 0 },
        },
        {
          id: 3, filename: 'museum.jpg', taken_at: '2025-04-01T10:00:04.000Z',
          curation: 'visible', ai_picked: false, ai_quality_score: 0.61,
          width: 4000, height: 3000,
          peer_curation: { hidden: 1, favorite: 0 },
        },
      ],
    },
    {
      id: 2,
      cover_photo_id: 4,
      member_count: 2,
      ai_picked_photo_ids: [4],
      ai_picked_confidence: 'low',
      runner_up_delta: 0.02,
      duplicate_candidate: true,
      duplicate_recommended_photo_id: 4,
      duplicate_deletable_count: 1,
      duplicate_deletable_bytes: 2_400_000,
      orientation_pair: false,
      photos: [
        {
          id: 4, filename: 'seagull.jpg', taken_at: '2025-04-02T09:00:00.000Z',
          curation: 'visible', ai_picked: true, ai_quality_score: 0.55,
          width: 4000, height: 3000,
          peer_curation: { hidden: 0, favorite: 0 },
        },
        {
          id: 5, filename: 'steak.jpg', taken_at: '2025-04-02T09:00:01.000Z',
          curation: 'visible', ai_picked: false, ai_quality_score: 0.53,
          width: 4000, height: 3000,
          peer_curation: { hidden: 0, favorite: 0 },
        },
      ],
    },
  ],
  user_calibration: null,
}

// A format pair (.claude/plans/orientierungs-varianten.md): the same motif
// portrait and landscape. The card tags it "Hoch + Quer" and offers
// "Bestes je Format behalten" and "Nicht dasselbe Motiv".
const PAIR_GROUP: ReviewQueueResponse['groups'][number] = {
  id: 3,
  cover_photo_id: 6,
  member_count: 3,
  ai_picked_photo_ids: [6, 8],
  ai_picked_confidence: 'medium',
  runner_up_delta: 0.06,
  duplicate_candidate: false,
  duplicate_recommended_photo_id: null,
  duplicate_deletable_count: 0,
  duplicate_deletable_bytes: 0,
  orientation_pair: true,
  photos: [
    {
      id: 6, filename: 'castle.jpg', taken_at: '2025-04-03T11:00:00.000Z',
      curation: 'visible', ai_picked: true, ai_quality_score: 0.81,
      width: 4000, height: 3000,
      peer_curation: { hidden: 0, favorite: 0 },
    },
    {
      id: 7, filename: 'museum.jpg', taken_at: '2025-04-03T11:00:12.000Z',
      curation: 'visible', ai_picked: false, ai_quality_score: 0.64,
      width: 3000, height: 4000,
      peer_curation: { hidden: 0, favorite: 0 },
    },
    {
      id: 8, filename: 'fish.jpg', taken_at: '2025-04-03T11:00:20.000Z',
      curation: 'visible', ai_picked: true, ai_quality_score: 0.77,
      width: 3000, height: 4000,
      peer_curation: { hidden: 0, favorite: 0 },
    },
  ],
}

const QUEUE_WITH_PAIR: ReviewQueueResponse = {
  ...QUEUE,
  total: 3,
  groups: [PAIR_GROUP, ...QUEUE.groups],
}

const queueHandlers = [
  http.get('/api/photos/groups/review-queue', () => HttpResponse.json(QUEUE)),
  ...defaultHandlers,
]

const meta: Meta<typeof ReviewQueueView> = {
  title: 'Views/ReviewQueueView',
  component: ReviewQueueView,
  decorators: [routeFromParameters('/fotos/review-queue')],
  parameters: { msw: { handlers: queueHandlers } },
}

export default meta
type Story = StoryObj<typeof ReviewQueueView>

export const MitGruppen: Story = { name: 'Mit Gruppen' }

export const MitFormatpaar: Story = {
  name: 'Mit Formatpaar',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos/groups/review-queue', ({ request }) => {
          const pairsOnly = new URL(request.url).searchParams.get('orientationPair') === 'true'
          return HttpResponse.json(
            pairsOnly ? { ...QUEUE_WITH_PAIR, total: 1, groups: [PAIR_GROUP] } : QUEUE_WITH_PAIR,
          )
        }),
        ...queueHandlers,
      ],
    },
  },
}

export const NurFormatpaare: Story = {
  name: 'Chip „Formatpaare"',
  parameters: {
    route: '/fotos/review-queue?pairs=pairs',
    msw: {
      handlers: [
        http.get('/api/photos/groups/review-queue', () =>
          HttpResponse.json({ ...QUEUE_WITH_PAIR, total: 1, groups: [PAIR_GROUP] }),
        ),
        ...queueHandlers,
      ],
    },
  },
}

export const NichtsZuEntscheiden: Story = {
  name: 'Nichts zu entscheiden',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos/groups/review-queue', () =>
          HttpResponse.json({
            total: 0, high_confidence_total: 0, offset: 0, groups: [], user_calibration: null,
          }),
        ),
        ...queueHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos/groups/review-queue', async () => {
          await delay('infinite')
          return HttpResponse.json(QUEUE)
        }),
        ...queueHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos/groups/review-queue', () =>
          HttpResponse.json({ message: 'Warteschlange nicht erreichbar' }, { status: 500 }),
        ),
        ...queueHandlers,
      ],
    },
  },
}
