import type { Meta, StoryObj } from '@storybook/vue3'
import OverviewView from '../views/finance/OverviewView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_OVERVIEW } from './finance-mock-data'
import { routeFromParameters } from './storyRoute'

/** The finance landing page, in each state it can be in (issue #1281). */

const overviewHandlers = [
  http.get('/api/finance/overview', () => HttpResponse.json(MOCK_OVERVIEW)),
  ...defaultHandlers,
]

const meta: Meta<typeof OverviewView> = {
  title: 'Views/OverviewView',
  component: OverviewView,
  decorators: [routeFromParameters('/finanzen')],
  parameters: { msw: { handlers: overviewHandlers } },
}

export default meta
type Story = StoryObj<typeof OverviewView>

export const MitKonten: Story = { name: 'Mit Konten' }

/**
 * Nothing configured yet. `is_default` is what the backend sets before the
 * user has saved an arrangement, and the view offers a hint for it.
 */
export const NochNichtEingerichtet: Story = {
  name: 'Noch nicht eingerichtet',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/overview', () =>
          HttpResponse.json({ ...MOCK_OVERVIEW, is_default: true, sections: [], unassigned: [] }),
        ),
        ...overviewHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/overview', async () => {
          await delay('infinite')
          return HttpResponse.json(MOCK_OVERVIEW)
        }),
        ...overviewHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/overview', () =>
          HttpResponse.json({ code: 'internal', message: 'Übersicht konnte nicht geladen werden.' }, { status: 500 }),
        ),
        ...overviewHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
