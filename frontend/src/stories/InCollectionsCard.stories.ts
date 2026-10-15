import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import InCollectionsCard from '../components/collections/InCollectionsCard.vue'
import { defaultHandlers } from './handlers'

/**
 * "Sammelmappen" on a detail page (#1548): where the item is filed, whether it
 * lies in the basket, and the two ways to change that.
 */

const filed = http.get('/api/collections/of/:type/:id', () =>
  HttpResponse.json({
    items: [
      { id: 1, name: 'Nebenkosten 2026', entity_type: null, archived_at: null },
      { id: 5, name: 'Umzug 2024', entity_type: 'meter', archived_at: '2025-01-10T00:00:00Z' },
    ],
  }),
)

const meta: Meta<typeof InCollectionsCard> = {
  title: 'Components/InCollectionsCard',
  component: InCollectionsCard,
  parameters: { msw: { handlers: defaultHandlers } },
  args: { type: 'meter', id: 3, title: 'Wasser Haupt' },
}

export default meta
type Story = StoryObj<typeof InCollectionsCard>

export const InMappen: Story = {
  parameters: { msw: { handlers: [filed, ...defaultHandlers] } },
}

export const NirgendsAbgelegt: Story = {}

/** Where the page has its own basket button (transactions). */
export const OhneBasketKnopf: Story = {
  args: { type: 'transaction', id: 7, hideBasket: true },
}
