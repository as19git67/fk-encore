import type { Meta, StoryObj } from '@storybook/vue3'
import TransactionDetailView from '../views/finance/TransactionDetailView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_ACCOUNTS, MOCK_FINANCE_TAGS, MOCK_TRANSACTIONS } from './finance-mock-data'
import { routeFromParameters } from './storyRoute'

/**
 * One booking in full (issue #1281): the detail page behind every list row.
 * The stories cover the plain booking, one with tags and a linked document,
 * and the two ways the page can fail to show anything — still loading, and
 * a transaction that is not there.
 */

const ROUTE = '/finanzen/umsaetze/1'
const TX = MOCK_TRANSACTIONS[0]!

const detailHandlers = [
  http.get('/api/finance/accounts', () => HttpResponse.json({ items: MOCK_ACCOUNTS })),
  http.get('/api/finance/tags', () => HttpResponse.json({ items: MOCK_FINANCE_TAGS })),
  http.get('/api/finance/transaction-splits', () => HttpResponse.json({ items: [] })),
  http.get('/api/finance/transactions/:id/documents', () => HttpResponse.json({ items: [] })),
  http.get('/api/finance/transactions/:id', () => HttpResponse.json(TX)),
  ...defaultHandlers,
]

const meta: Meta<typeof TransactionDetailView> = {
  title: 'Views/TransactionDetailView',
  component: TransactionDetailView,
  decorators: [routeFromParameters(ROUTE)],
  parameters: { msw: { handlers: detailHandlers } },
}

export default meta
type Story = StoryObj<typeof TransactionDetailView>

export const Buchung: Story = { name: 'Buchung' }

export const OhneSchlagworte: Story = {
  name: 'Ohne Schlagworte',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/transactions/:id', () =>
          HttpResponse.json({ ...TX, tags: [], notice: null }),
        ),
        ...detailHandlers,
      ],
    },
  },
}

export const MitBeleg: Story = {
  name: 'Mit verknüpftem Beleg',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/transactions/:id/documents', () =>
          HttpResponse.json({
            items: [
              { document_id: 7, title: 'Rechnung Juni', original_filename: 'rechnung-juni.pdf' },
            ],
          }),
        ),
        ...detailHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/transactions/:id', async () => {
          await delay('infinite')
          return HttpResponse.json(TX)
        }),
        ...detailHandlers,
      ],
    },
  },
}

export const NichtGefunden: Story = {
  name: 'Buchung nicht gefunden',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/transactions/:id', () =>
          HttpResponse.json({ message: 'Buchung nicht gefunden' }, { status: 404 }),
        ),
        ...detailHandlers,
      ],
    },
  },
}
