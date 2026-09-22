import type { Meta, StoryObj } from '@storybook/vue3'
import AccountsView from '../views/finance/AccountsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_ACCOUNTS } from './finance-mock-data'
import { routeFromParameters } from './storyRoute'

/** The accounts list, in each state it can be in (issue #1281). */

const accountHandlers = [
  http.get('/api/finance/accounts', () => HttpResponse.json({ items: MOCK_ACCOUNTS })),
  ...defaultHandlers,
]

const meta: Meta<typeof AccountsView> = {
  title: 'Views/AccountsView',
  component: AccountsView,
  decorators: [routeFromParameters('/finanzen/konten')],
  parameters: { msw: { handlers: accountHandlers } },
}

export default meta
type Story = StoryObj<typeof AccountsView>

export const MitKonten: Story = { name: 'Mit Konten' }

export const NochKeineKonten: Story = {
  name: 'Noch keine Konten',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/accounts', () => HttpResponse.json({ items: [] })),
        ...accountHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/accounts', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [] })
        }),
        ...accountHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/accounts', () =>
          HttpResponse.json({ code: 'internal', message: 'Konten konnten nicht geladen werden.' }, { status: 500 }),
        ),
        ...accountHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
