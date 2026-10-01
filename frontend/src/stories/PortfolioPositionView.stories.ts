import type { Meta, StoryObj } from '@storybook/vue3'
import PortfolioPositionView from '../views/finance/PortfolioPositionView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_PORTFOLIO_POSITION } from './finance-mock-data'
import { routeFromParameters } from './storyRoute'

/** One security in detail (issue #1336, stage 3). */

const handlers = [
  http.get('/api/finance/portfolio/positions/:key', () => HttpResponse.json(MOCK_PORTFOLIO_POSITION)),
  ...defaultHandlers,
]

const meta: Meta<typeof PortfolioPositionView> = {
  title: 'Views/PortfolioPositionView',
  component: PortfolioPositionView,
  decorators: [routeFromParameters('/finanzen/portfolio/DE0000000AAA1')],
  parameters: { msw: { handlers } },
}

export default meta
type Story = StoryObj<typeof PortfolioPositionView>

export const Standard: Story = { name: 'Mit Verlauf und Verkäufen' }

export const OhneVerlauf: Story = {
  name: 'Ohne Verlauf',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/portfolio/positions/:key', () =>
          HttpResponse.json({ ...MOCK_PORTFOLIO_POSITION, history: [], sales: [] }),
        ),
        ...handlers,
      ],
    },
  },
}

export const NichtGefunden: Story = {
  name: 'Nicht gefunden',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/portfolio/positions/:key', () =>
          HttpResponse.json({ code: 'not_found', message: 'position not found' }, { status: 404 }),
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
        http.get('/api/finance/portfolio/positions/:key', async () => {
          await delay('infinite')
          return HttpResponse.json(MOCK_PORTFOLIO_POSITION)
        }),
        ...handlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
