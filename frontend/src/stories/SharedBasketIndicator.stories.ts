import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import SharedBasketIndicator from '../components/collections/SharedBasketIndicator.vue'
import { EMPTY_BASKET, defaultHandlers } from './handlers'
import type { CollectionMember } from '../api/collections'

/**
 * The basket in modules without a drawer of their own (#1548): every type in
 * one pile, grouped, with "save as collection" in the footer.
 */

const MEMBERS: CollectionMember[] = [
  { entity_type: 'photo', entity_id: 11, title: 'IMG_0001.jpg', subtitle: 'Musterstadt', date: '2026-05-01T10:00:00Z', amount: null, currency: null, joined_by: 'user', added_at: '' },
  { entity_type: 'photo', entity_id: 12, title: 'IMG_0002.jpg', subtitle: null, date: '2026-05-01T10:05:00Z', amount: null, currency: null, joined_by: 'user', added_at: '' },
  { entity_type: 'document', entity_id: 21, title: 'Rechnung Wasserschaden', subtitle: 'Beispiel GmbH', date: '2026-05-03', amount: null, currency: null, joined_by: 'user', added_at: '' },
  { entity_type: 'transaction', entity_id: 31, title: 'Handwerk Muster', subtitle: 'Girokonto', date: '2026-05-10', amount: '-480.00', currency: 'EUR', joined_by: 'user', added_at: '' },
  { entity_type: 'meter_reading', entity_id: 41, title: 'Wasser Haupt: 1234.5 m3', subtitle: 'Wasser Haupt', date: '2026-05-02T08:00:00Z', amount: null, currency: null, joined_by: 'user', added_at: '' },
]

const filled = http.get('/api/collections/basket', () =>
  HttpResponse.json({ ...EMPTY_BASKET, members: MEMBERS, total: MEMBERS.length }),
)

const meta: Meta<typeof SharedBasketIndicator> = {
  title: 'Components/SharedBasketIndicator',
  component: SharedBasketIndicator,
  parameters: { msw: { handlers: defaultHandlers } },
  render: () => ({
    components: { SharedBasketIndicator },
    template: '<div style="padding:1rem;display:flex;justify-content:flex-end"><SharedBasketIndicator /></div>',
  }),
}

export default meta
type Story = StoryObj<typeof SharedBasketIndicator>

export const Gemischt: Story = {
  parameters: { msw: { handlers: [filled, ...defaultHandlers] } },
}

export const Leer: Story = {}
