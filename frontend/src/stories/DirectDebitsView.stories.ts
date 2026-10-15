import type { Meta, StoryObj } from '@storybook/vue3'
import DirectDebitsView from '../views/finance/DirectDebitsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import type { UpcomingDebit } from '../api/finance'
import { routeFromParameters } from './storyRoute'

/**
 * Finanzen › Lastschriften (#1526): the debits still expected in a period,
 * with the sum in the result line and the past bookings of a series on
 * demand. Counterparties and identifiers are synthetic.
 */

const DEBITS: UpcomingDebit[] = [
  {
    mandate_id: 1, account_id: 1, account_label: 'Girokonto',
    counterparty: 'Muster Telekom', creditor_id: 'DE00ZZZ00000000001', mandate_ref: 'REF-0001',
    payment_channel: 'direct_debit', expected_date: '2026-10-10', overdue: true,
    typical_amount: '-39.99', interval_days: 30, last_seen: '2026-09-10', transaction_count: 14,
  },
  {
    mandate_id: 2, account_id: 1, account_label: 'Girokonto',
    counterparty: 'Stadtwerke Musterstadt', creditor_id: 'DE00ZZZ00000000002', mandate_ref: 'REF-0002',
    payment_channel: 'direct_debit', expected_date: '2026-10-20', overdue: false,
    typical_amount: '-84.00', interval_days: 30, last_seen: '2026-09-20', transaction_count: 24,
  },
  {
    mandate_id: 3, account_id: 2, account_label: 'Gemeinschaftskonto mit einem recht langen Namen',
    counterparty: 'Beispiel Versicherung Aktiengesellschaft für Haus und Hof', creditor_id: null, mandate_ref: null,
    payment_channel: 'direct_debit', expected_date: '2026-10-28', overdue: false,
    typical_amount: '-132.50', interval_days: 91, last_seen: '2026-07-28', transaction_count: 9,
  },
]

const handlers = [
  http.get('/api/finance/mandates/upcoming', () =>
    HttpResponse.json({ from: '2026-10-15', until: '2026-10-31', items: DEBITS, count: 3, total_amount: '-256.49' }),
  ),
  http.get('/api/finance/mandates/:id/history', ({ params }) =>
    HttpResponse.json({
      mandate_id: Number(params.id),
      counterparty: 'Stadtwerke Musterstadt',
      items: [
        { id: 501, booking_date: '2026-09-20', amount: '-84.00', purpose: 'Abschlag September' },
        { id: 502, booking_date: '2026-08-20', amount: '-84.00', purpose: 'Abschlag August' },
      ],
    }),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof DirectDebitsView> = {
  title: 'Views/DirectDebitsView',
  component: DirectDebitsView,
  decorators: [routeFromParameters('/finanzen/lastschriften')],
  parameters: { msw: { handlers } },
}

export default meta
type Story = StoryObj<typeof DirectDebitsView>

export const MitLastschriften: Story = { name: 'Mit Lastschriften' }

export const NaechsterMonat: Story = {
  name: 'Zeitraum aus der URL',
  parameters: { route: '/finanzen/lastschriften?period=next-month' },
}

export const NichtsErwartet: Story = {
  name: 'Nichts erwartet',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/mandates/upcoming', () =>
          HttpResponse.json({ from: '2026-10-15', until: '2026-10-31', items: [], count: 0, total_amount: '0.00' }),
        ),
        ...handlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/mandates/upcoming', async () => {
          await delay('infinite')
          return HttpResponse.json({})
        }),
        ...handlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/mandates/upcoming', () => HttpResponse.json({}, { status: 500 })),
        ...handlers,
      ],
    },
  },
}
