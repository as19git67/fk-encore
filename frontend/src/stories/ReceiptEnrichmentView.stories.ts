import type { Meta, StoryObj } from '@storybook/vue3'
import ReceiptEnrichmentView from '../views/finance/ReceiptEnrichmentView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { routeFromParameters } from './storyRoute'

/**
 * Bookings whose receipt says something the booking does not yet (issue
 * #1281): a sender, a date, an amount waiting to be taken over. Empty here
 * means everything has been decided — the page says so rather than showing
 * a bare list.
 */

const ITEMS = [
  {
    transaction_id: 1,
    booking_date: '2025-06-08',
    amount: '-24.99',
    counterparty: 'Musterladen KG',
    document_id: 7,
    doc_sender: 'Musterladen KG',
    doc_date: '2025-06-08',
    doc_amount: 24.99,
    doc_status: 'classified',
  },
  {
    transaction_id: 2,
    booking_date: '2025-06-05',
    amount: '-149.00',
    counterparty: null,
    document_id: 8,
    doc_sender: 'Beispiel Werkstatt GmbH',
    doc_date: '2025-06-04',
    doc_amount: 149,
    doc_status: 'classified',
  },
]

const receiptHandlers = [
  http.get('/api/finance/receipt-enrichments/pending', () => HttpResponse.json({ items: ITEMS })),
  ...defaultHandlers,
]

const meta: Meta<typeof ReceiptEnrichmentView> = {
  title: 'Views/ReceiptEnrichmentView',
  component: ReceiptEnrichmentView,
  decorators: [routeFromParameters('/finanzen/belegabgleich')],
  parameters: { msw: { handlers: receiptHandlers } },
}

export default meta
type Story = StoryObj<typeof ReceiptEnrichmentView>

export const OffeneVorschlaege: Story = { name: 'Offene Vorschläge' }

export const AllesErledigt: Story = {
  name: 'Alles erledigt',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/receipt-enrichments/pending', () =>
          HttpResponse.json({ items: [] }),
        ),
        ...receiptHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/receipt-enrichments/pending', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [] })
        }),
        ...receiptHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/receipt-enrichments/pending', () =>
          HttpResponse.json({ message: 'Dienst nicht erreichbar' }, { status: 500 }),
        ),
        ...receiptHandlers,
      ],
    },
  },
}
