import type { Meta, StoryObj } from '@storybook/vue3'
import AccountTransactionsView from '../views/finance/AccountTransactionsView.vue'
import { routeFromParameters } from './storyRoute'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_FINANCE_TAGS, MOCK_OVERVIEW, MOCK_TRANSACTIONS } from './finance-mock-data'

/**
 * The bookings list — one of the two views this whole unification started
 * with (issue #1272), and until now without a story. Every state the page
 * can be in gets one, so a regression shows up in a screenshot and the
 * overflow and focus-ring guards run against all of them (issue #1281).
 */

const ROUTE = '/finanzen/uebersicht/konto/1'

const financeHandlers = [
  http.get('/api/finance/overview', () => HttpResponse.json(MOCK_OVERVIEW)),
  http.get('/api/finance/tags', () => HttpResponse.json({ items: MOCK_FINANCE_TAGS })),
  http.get('/api/finance/transactions', () =>
    HttpResponse.json({ items: MOCK_TRANSACTIONS, total: MOCK_TRANSACTIONS.length }),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof AccountTransactionsView> = {
  title: 'Views/AccountTransactionsView',
  component: AccountTransactionsView,
  decorators: [routeFromParameters(ROUTE)],
  parameters: { msw: { handlers: financeHandlers } },
}

export default meta
type Story = StoryObj<typeof AccountTransactionsView>

export const MitBuchungen: Story = {
  name: 'Mit Buchungen',
}

export const LeeresKonto: Story = {
  name: 'Konto ohne Buchungen',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/transactions', () => HttpResponse.json({ items: [], total: 0 })),
        ...financeHandlers,
      ],
    },
  },
}

/**
 * Filtered down to nothing — a different empty than "this account is new",
 * and the one that has to offer a way back out of the filter.
 */
export const KeineTreffer: Story = {
  name: 'Filter ohne Treffer',
  parameters: {
    route: `${ROUTE}?q=gibtesnicht`,
    msw: {
      handlers: [
        http.get('/api/finance/transactions', () => HttpResponse.json({ items: [], total: 0 })),
        ...financeHandlers,
      ],
    },
  },
}

/**
 * The first load, held open. `delay('infinite')` keeps the request pending
 * for as long as the story lives, so the skeleton is what the screenshot
 * catches.
 */
export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/transactions', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [], total: 0 })
        }),
        ...financeHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/transactions', () =>
          HttpResponse.json({ code: 'internal', message: 'Buchungen konnten nicht geladen werden.' }, { status: 500 }),
        ),
        ...financeHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
