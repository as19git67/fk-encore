import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import CollectionDetailView from '../views/CollectionDetailView.vue'
import { EMPTY_BASKET, defaultHandlers } from './handlers'
import { routeFromParameters } from './storyRoute'
import type { CollectionMember } from '../api/collections'

/**
 * A mixed collection (#1548, stage 3): members grouped by type, each group
 * with the way into its module's list.
 */

const MEMBERS: CollectionMember[] = [
  { entity_type: 'document', entity_id: 21, title: 'Rechnung Wasserschaden', subtitle: 'Beispiel GmbH', date: '2026-05-03', amount: null, currency: null, joined_by: 'user', added_at: '2026-05-04T00:00:00Z' },
  { entity_type: 'photo', entity_id: 11, title: 'IMG_0001.jpg', subtitle: 'Musterstadt', date: '2026-05-01T10:00:00Z', amount: null, currency: null, joined_by: 'user', added_at: '2026-05-02T00:00:00Z' },
  { entity_type: 'photo', entity_id: 12, title: 'IMG_0002.jpg', subtitle: null, date: '2026-05-01T10:05:00Z', amount: null, currency: null, joined_by: 'user', added_at: '2026-05-02T00:00:00Z' },
  { entity_type: 'transaction', entity_id: 31, title: 'Handwerk Muster', subtitle: 'Girokonto', date: '2026-05-10', amount: '-480.00', currency: 'EUR', joined_by: 'user', added_at: '2026-05-11T00:00:00Z' },
  { entity_type: 'security', entity_id: 51, title: 'Beispiel Fonds A', subtitle: 'Depot Beispielbank', date: '2026-02-01T00:00:00Z', amount: null, currency: null, joined_by: 'user', added_at: '2026-05-11T00:00:00Z' },
]

const detail = http.get('/api/collections/:id', ({ params }) =>
  params.id === 'basket'
    ? HttpResponse.json(EMPTY_BASKET)
    : HttpResponse.json({
        ...EMPTY_BASKET,
        id: 3,
        name: 'Wasserschaden Beispielstraße',
        kind: 'manual',
        counts: { document: 1, photo: 2, transaction: 1, security: 1 },
        total: 5,
        members: MEMBERS,
        hidden_count: 1,
      }),
)
const opened = http.post('/api/collections/:id/opened', () => HttpResponse.json({ ok: true }))

const meta: Meta<typeof CollectionDetailView> = {
  title: 'Views/CollectionDetailView',
  component: CollectionDetailView,
  decorators: [routeFromParameters('/sammelmappen/3')],
  parameters: { msw: { handlers: [...defaultHandlers, detail, opened] } },
}

export default meta
type Story = StoryObj<typeof CollectionDetailView>

export const Gemischt: Story = {}

export const NurFotos: Story = { parameters: { route: '/sammelmappen/3?type=photo' } }
