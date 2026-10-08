import type { Meta, StoryObj } from '@storybook/vue3'
import PortfolioView from '../views/finance/PortfolioView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import {
  MOCK_PORTFOLIO,
  MOCK_PORTFOLIO_EMPTY,
  MOCK_PORTFOLIO_REVIEW,
  MOCK_PORTFOLIO_REVIEW_EMPTY,
  MOCK_PORTFOLIO_REVIEW_WITH_IGNORED,
  MOCK_PORTFOLIO_TRANSACTIONS,
} from './finance-mock-data'
import { routeFromParameters } from './storyRoute'

/** The portfolio page (issue #1336), in each state it can be in. */

/** A read of the documents on the server, finished and still running. */
const ENRICH_TOTALS = {
  documents_examined: 3, created: 1, enriched: 1, linked: 0,
  conflicts: 1, unverified: 1, skipped_no_holding: 0, skipped_no_transaction: 0,
}
const ENRICH_RUN_DONE = {
  id: 1, status: 'done', started_at: new Date(Date.now() - 60_000).toISOString(),
  finished_at: new Date().toISOString(), account_ids: [12], totals: ENRICH_TOTALS, error: null,
}
const ENRICH_RUN_RUNNING = {
  ...ENRICH_RUN_DONE, id: 2, status: 'running', finished_at: null,
  totals: { ...ENRICH_TOTALS, documents_examined: 42 },
}

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
  http.get('/api/finance/portfolio/review', ({ request }) =>
    HttpResponse.json(
      new URL(request.url).searchParams.get('ignored') === 'true' ? MOCK_PORTFOLIO_REVIEW_WITH_IGNORED : MOCK_PORTFOLIO_REVIEW,
    ),
  ),
  http.post('/api/finance/portfolio/documents/:id/ignore', ({ params }) =>
    HttpResponse.json({ document_id: Number(params.id), ignored: true }),
  ),
  http.delete('/api/finance/portfolio/documents/:id/ignore', ({ params }) =>
    HttpResponse.json({ document_id: Number(params.id), ignored: false }),
  ),
  http.post('/api/finance/portfolio/documents/:id/apply', () =>
    HttpResponse.json({ document_id: 305, outcome: 'enriched', depot_transaction_id: 904, account_id: 12, detail: null, statement_net: '-2459.50', transaction_net: '-2457.00', isin: 'DE000000BBB2', wkn: null, depot_number: null, matched_by: 'holding', date_source: 'statement', llm_status: 'cached' }),
  ),
  http.post('/api/finance/portfolio/documents/enrich/start', () => HttpResponse.json({ run: ENRICH_RUN_DONE })),
  http.get('/api/finance/portfolio/documents/enrich/status', () => HttpResponse.json({ run: null })),
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
        http.get('/api/finance/portfolio/review', () => HttpResponse.json(MOCK_PORTFOLIO_REVIEW_EMPTY)),
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

export const IgnorierteBelege: Story = {
  name: 'Prüfliste mit ignorierten Belegen',
  play: async ({ canvasElement }) => {
    // Turn on "show ignored" once the review has loaded.
    const deadline = Date.now() + 5000
    let box: HTMLInputElement | null = null
    while (!box && Date.now() < deadline) {
      box = canvasElement.querySelector<HTMLInputElement>('#pr-show-ignored')
      if (!box) await new Promise((r) => setTimeout(r, 50))
    }
    box?.click()
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}

/** Reading the documents on the server: the button shows how far it got. */
export const BelegeWerdenEingelesen: Story = {
  name: 'Belege werden eingelesen',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/portfolio/documents/enrich/status', () => HttpResponse.json({ run: ENRICH_RUN_RUNNING })),
        ...portfolioHandlers,
      ],
    },
  },
}
