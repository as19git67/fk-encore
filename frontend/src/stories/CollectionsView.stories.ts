import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import CollectionsView from '../views/CollectionsView.vue'
import { defaultHandlers } from './handlers'
import { routeFromParameters } from './storyRoute'
import type { CollectionSummary } from '../api/collections'

/**
 * Every collection of every type (#1548, stage 3): search, filters, sort,
 * tiles or table; starred folders first.
 */

function summary(id: number, name: string, extra: Partial<CollectionSummary> = {}): CollectionSummary {
  return {
    id, name, description: null, entity_type: null, kind: 'manual', visibility: 'private', group_id: null,
    archived_at: null, created_by: 'user', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    favourite: false, last_opened_at: null, counts: {}, total: 0, can_administer: true, rule: null, ...extra,
  }
}

const ITEMS = [
  summary(1, 'Nebenkosten 2026', { counts: { document: 4, transaction: 12, meter: 2 }, total: 18, favourite: true }),
  summary(2, 'Urlaub Musterstadt', { entity_type: 'photo', counts: { photo: 140 }, total: 140 }),
  summary(3, 'Wasserschaden Beispielstraße', { counts: { photo: 6, document: 2, transaction: 1 }, total: 9, visibility: 'group', group_id: 1, can_administer: false }),
  summary(4, 'Steuer 2026', { entity_type: 'transaction', counts: { transaction: 40 }, total: 40 }),
  summary(5, 'Vorschläge zur Versicherung', { entity_type: 'document', counts: { document: 3 }, total: 3, created_by: 'assistant' }),
  summary(6, 'Zählerstände Auszug', { entity_type: 'meter_reading', counts: { meter_reading: 4 }, total: 4 }),
  summary(7, 'Stromzähler', {
    entity_type: 'meter',
    kind: 'rule',
    counts: { meter: 3 },
    total: 3,
    rule: { type: 'meter', criteria: { meter_types: ['electricity'] } },
  }),
]

const listed = http.get('/api/collections', () => HttpResponse.json({ items: ITEMS }))

const meta: Meta<typeof CollectionsView> = {
  title: 'Views/CollectionsView',
  component: CollectionsView,
  decorators: [routeFromParameters('/sammelmappen')],
  parameters: { msw: { handlers: [listed, ...defaultHandlers] } },
}

export default meta
type Story = StoryObj<typeof CollectionsView>

export const Kacheln: Story = {}

export const Tabelle: Story = { parameters: { route: '/sammelmappen?view=table' } }

export const Gefiltert: Story = { parameters: { route: '/sammelmappen?type=photo&fav=1' } }

export const Leer: Story = { parameters: { msw: { handlers: defaultHandlers } } }
