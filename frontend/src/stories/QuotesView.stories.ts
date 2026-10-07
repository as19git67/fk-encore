import type { Meta, StoryObj } from '@storybook/vue3'
import QuotesView from '../views/finance/QuotesView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_PORTFOLIO, MOCK_QUOTES, MOCK_QUOTES_EMPTY } from './finance-mock-data'
import { routeFromParameters } from './storyRoute'

/** The quotes page (`.claude/plans/kurse.md`, stage 2), in each state it can be in. */

const quotesHandlers = [
  http.get('/api/finance/quotes', ({ request }) =>
    HttpResponse.json({ ...MOCK_QUOTES, range: new URL(request.url).searchParams.get('range') ?? '1m' }),
  ),
  http.get('/api/finance/portfolio', () => HttpResponse.json(MOCK_PORTFOLIO)),
  http.post('/api/finance/quotes/refresh', () =>
    HttpResponse.json({ positions: 5, resolved: 4, unresolved: 1, fetched: 4, points: 12, rate_limited: false, errors: [] }),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof QuotesView> = {
  title: 'Views/QuotesView',
  component: QuotesView,
  decorators: [routeFromParameters('/finanzen/kurse')],
  parameters: { msw: { handlers: quotesHandlers } },
}

export default meta
type Story = StoryObj<typeof QuotesView>

/** Tiles for every held security: priced ones with their sparkline, one without a symbol, one still waiting. */
export const Default: Story = {}

/** A year's range from the URL. */
export const YearRange: Story = {
  parameters: { route: '/finanzen/kurse?range=1y' },
}

/** The search narrows the tiles in place. */
export const Filtered: Story = {
  parameters: { route: '/finanzen/kurse?q=alpha' },
}

/** No security held in the chosen depots. */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [http.get('/api/finance/quotes', () => HttpResponse.json(MOCK_QUOTES_EMPTY)), ...quotesHandlers],
    },
  },
}

/** The first load. */
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [http.get('/api/finance/quotes', async () => { await delay('infinite'); return HttpResponse.json(MOCK_QUOTES) }), ...quotesHandlers],
    },
  },
}

/** The quotes could not be loaded. */
export const LoadError: Story = {
  parameters: {
    msw: {
      handlers: [http.get('/api/finance/quotes', () => HttpResponse.json({ message: 'Datenbank nicht erreichbar' }, { status: 500 })), ...quotesHandlers],
    },
  },
}
