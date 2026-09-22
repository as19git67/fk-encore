import type { Meta, StoryObj } from '@storybook/vue3'
import BankcontactDetailView from '../views/finance/BankcontactDetailView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_ACCOUNTS, MOCK_BANKCONTACTS } from './finance-mock-data'
import { routeFromParameters } from './storyRoute'

/**
 * One bank contact (issue #1281): the page that both creates a contact and
 * edits one. The new-contact form and a contact that has never synced look
 * alike on purpose — the difference is what the page can already do.
 */

const contactHandlers = [
  http.get('/api/finance/bankcontacts', () => HttpResponse.json({ items: MOCK_BANKCONTACTS })),
  http.get('/api/finance/accounts', () => HttpResponse.json({ items: MOCK_ACCOUNTS })),
  ...defaultHandlers,
]

const meta: Meta<typeof BankcontactDetailView> = {
  title: 'Views/BankcontactDetailView',
  component: BankcontactDetailView,
  decorators: [routeFromParameters('/finanzen/bankkontakte/1')],
  parameters: { msw: { handlers: contactHandlers } },
}

export default meta
type Story = StoryObj<typeof BankcontactDetailView>

export const EingerichteterKontakt: Story = { name: 'Eingerichteter Kontakt' }

export const OhneZugangsdaten: Story = {
  name: 'Ohne Zugangsdaten',
  parameters: { route: '/finanzen/bankkontakte/2' },
}

export const NeuerKontakt: Story = {
  name: 'Neuer Kontakt',
  parameters: { route: '/finanzen/bankkontakte/neu' },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
