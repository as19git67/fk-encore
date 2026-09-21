import type { Meta, StoryObj } from '@storybook/vue3'
import BankcontactsView from '../views/finance/BankcontactsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_BANKCONTACTS } from './finance-mock-data'
import { routeFromParameters } from './storyRoute'

/**
 * The bank contacts, in each state (issue #1281). The second fixture has no
 * credentials and has never synced — the state a contact is in right after
 * it is created, and the one the list has to make obvious.
 */

const bankcontactHandlers = [
  http.get('/api/finance/bankcontacts', () => HttpResponse.json({ items: MOCK_BANKCONTACTS })),
  ...defaultHandlers,
]

const meta: Meta<typeof BankcontactsView> = {
  title: 'Views/BankcontactsView',
  component: BankcontactsView,
  decorators: [routeFromParameters('/finanzen/bankkontakte')],
  parameters: { msw: { handlers: bankcontactHandlers } },
}

export default meta
type Story = StoryObj<typeof BankcontactsView>

export const MitBankkontakten: Story = { name: 'Mit Bankkontakten' }

export const NochKeine: Story = {
  name: 'Noch keine Bankkontakte',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/bankcontacts', () => HttpResponse.json({ items: [] })),
        ...bankcontactHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/bankcontacts', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [] })
        }),
        ...bankcontactHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/bankcontacts', () =>
          HttpResponse.json({ code: 'internal', message: 'Bankkontakte konnten nicht geladen werden.' }, { status: 500 }),
        ),
        ...bankcontactHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
