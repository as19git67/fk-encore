import type { Meta, StoryObj } from '@storybook/vue3'
import PortfolioView from '../views/finance/PortfolioView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import {
  MOCK_PORTFOLIO,
  MOCK_PORTFOLIO_EMPTY,
  MOCK_PORTFOLIO_TRANSACTIONS,
} from './finance-mock-data'
import { routeFromParameters } from './storyRoute'

/** The portfolio page (issue #1336), in each state it can be in. */

const portfolioHandlers = [
  http.get('/api/finance/portfolio', () => HttpResponse.json(MOCK_PORTFOLIO)),
  http.get('/api/finance/portfolio/transactions', ({ request }) => {
    const url = new URL(request.url)
    const kind = url.searchParams.get('kind')
    const position = url.searchParams.get('position')
    const items = MOCK_PORTFOLIO_TRANSACTIONS.filter(
      (tx) => (!kind || tx.kind === kind) && (!position || tx.position_key === position),
    )
    let net = 0
    let fees = 0
    let taxes = 0
    for (const tx of items) {
      net += Number(tx.net_amount ?? 0)
      fees += Math.abs(Number(tx.fees ?? 0))
      taxes += Math.abs(Number(tx.tax ?? 0))
    }
    return HttpResponse.json({
      items,
      total: items.length,
      sums: { net_amount: net.toFixed(2), fees: fees.toFixed(2), taxes: taxes.toFixed(2) },
    })
  }),
  ...defaultHandlers,
]

const meta: Meta<typeof PortfolioView> = {
  title: 'Views/PortfolioView',
  component: PortfolioView,
  decorators: [routeFromParameters('/finanzen/portfolio')],
  parameters: { msw: { handlers: portfolioHandlers } },
}

export default meta
type Story = StoryObj<typeof PortfolioView>

export const MitPositionen: Story = { name: 'Mit Positionen' }

export const GefiltertAufPosition: Story = {
  name: 'Auf ein Wertpapier eingegrenzt',
  parameters: { route: '/finanzen/portfolio?position=DE0000000AAA1&closed=1' },
}

export const KeinDepot: Story = {
  name: 'Kein Depot',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/portfolio', () => HttpResponse.json(MOCK_PORTFOLIO_EMPTY)),
        http.get('/api/finance/portfolio/transactions', () =>
          HttpResponse.json({ items: [], total: 0, sums: { net_amount: '0.00', fees: '0.00', taxes: '0.00' } }),
        ),
        ...portfolioHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/portfolio', async () => {
          await delay('infinite')
          return HttpResponse.json(MOCK_PORTFOLIO)
        }),
        http.get('/api/finance/portfolio/transactions', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [], total: 0 })
        }),
        ...portfolioHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/portfolio', () =>
          HttpResponse.json({ code: 'internal', message: 'Portfolio konnte nicht geladen werden.' }, { status: 500 }),
        ),
        ...portfolioHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
