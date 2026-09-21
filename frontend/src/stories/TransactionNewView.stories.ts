import type { Meta, StoryObj } from '@storybook/vue3'
import TransactionNewView from '../views/finance/TransactionNewView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_ACCOUNTS, MOCK_FINANCE_TAGS } from './finance-mock-data'
import { routeFromParameters } from './storyRoute'

/**
 * Entering a cash booking by hand (issue #1281). The form leans on what was
 * paid to recently, so the story with suggestions and the one without are
 * two different pages.
 */

const ROUTE = '/finanzen/umsaetze/neu'

const newHandlers = [
  http.get('/api/finance/accounts', () => HttpResponse.json({ items: MOCK_ACCOUNTS })),
  http.get('/api/finance/tags', () => HttpResponse.json({ items: MOCK_FINANCE_TAGS })),
  http.get('/api/finance/transactions/recent-cash-recipients', () =>
    HttpResponse.json({
      items: [
        { counterparty: 'Musterbäckerei', count: 12 },
        { counterparty: 'Beispielmarkt', count: 7 },
        { counterparty: 'Kiosk am Beispielplatz', count: 3 },
      ],
    }),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof TransactionNewView> = {
  title: 'Views/TransactionNewView',
  component: TransactionNewView,
  decorators: [routeFromParameters(ROUTE)],
  parameters: { msw: { handlers: newHandlers } },
}

export default meta
type Story = StoryObj<typeof TransactionNewView>

export const LeeresFormular: Story = { name: 'Leeres Formular' }

export const OhneVorschlaege: Story = {
  name: 'Ohne Empfänger-Vorschläge',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/transactions/recent-cash-recipients', () =>
          HttpResponse.json({ items: [] }),
        ),
        ...newHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
