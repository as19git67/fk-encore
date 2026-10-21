import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import CollectionTotalsPanel from '../components/finance/CollectionTotalsPanel.vue'
import { EMPTY_BASKET, defaultHandlers } from './handlers'
import type { TransactionTotals } from '../api/finance'

/**
 * Sums of a transaction rule folder the assistant created: subtotals per tag
 * (its own grouping), switchable to month, quarter or year.
 */

const BY_TAG: TransactionTotals = {
  group_by: 'tag',
  currency: 'EUR',
  count: 9,
  total: -125040,
  groups: [
    { key: 'Handwerk', label: 'Handwerk', count: 5, sum: -98000 },
    { key: 'Garten', label: 'Garten', count: 3, sum: -24540 },
    { key: 'Ohne Tag', label: 'Ohne Tag', count: 1, sum: -2500 },
  ],
  first_date: '2026-01-12',
  last_date: '2026-09-30',
  other_currencies: [],
}

const BY_QUARTER: TransactionTotals = {
  ...BY_TAG,
  group_by: 'quarter',
  groups: [
    { key: '2026-Q1', label: 'Q1 2026', count: 3, sum: -40010 },
    { key: '2026-Q2', label: 'Q2 2026', count: 4, sum: -60030 },
    { key: '2026-Q3', label: 'Q3 2026', count: 2, sum: -25000 },
  ],
}

const collection = http.get('/api/collections/:id', () =>
  HttpResponse.json({
    ...EMPTY_BASKET,
    id: 7,
    name: 'Haus 2026',
    kind: 'rule',
    entity_type: 'transaction',
    rule: { type: 'transaction', criteria: { from: '2026-01-01', direction: 'out' }, totals: { group_by: 'tag' } },
    members: [],
  }),
)
const totals = http.post('/api/finance/transactions/totals', async ({ request }) => {
  const body = (await request.json()) as { group_by?: string }
  if (body.group_by === 'none') return HttpResponse.json({ ...BY_TAG, group_by: 'none', groups: [] })
  return HttpResponse.json(body.group_by === 'tag' ? BY_TAG : BY_QUARTER)
})

const meta: Meta<typeof CollectionTotalsPanel> = {
  title: 'Finance/CollectionTotalsPanel',
  component: CollectionTotalsPanel,
  args: { collectionId: 7 },
  parameters: { msw: { handlers: [...defaultHandlers, collection, totals] } },
}

export default meta
type Story = StoryObj<typeof CollectionTotalsPanel>

export const NachTag: Story = {}
