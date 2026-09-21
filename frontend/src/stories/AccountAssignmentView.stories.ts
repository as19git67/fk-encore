import type { Meta, StoryObj } from '@storybook/vue3'
import AccountAssignmentView from '../views/finance/AccountAssignmentView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_ACCOUNTS } from './finance-mock-data'
import { routeFromParameters } from './storyRoute'

/**
 * Who may see which account (issue #1281). Nothing is picked when the page
 * opens, so the first story is the page as it is entered; the others show
 * it with an account chosen, with and without anyone assigned.
 */

const ACCESS = [
  { user_id: 2, user_email: 'max@beispiel.test', user_name: 'Max Beispiel', level: 'read' as const },
  { user_id: 3, user_email: 'eva@beispiel.test', user_name: 'Eva Beispiel', level: 'write' as const },
]

const assignmentHandlers = [
  http.get('/api/finance/accounts', () => HttpResponse.json({ items: MOCK_ACCOUNTS })),
  http.get('/api/finance/admin/access/:id', () => HttpResponse.json({ items: ACCESS })),
  ...defaultHandlers,
]

const meta: Meta<typeof AccountAssignmentView> = {
  title: 'Views/AccountAssignmentView',
  component: AccountAssignmentView,
  decorators: [routeFromParameters('/finanzen/admin/zugriff')],
  parameters: { msw: { handlers: assignmentHandlers } },
}

export default meta
type Story = StoryObj<typeof AccountAssignmentView>

export const NochNichtsGewaehlt: Story = { name: 'Noch kein Konto gewählt' }

export const OhneKonten: Story = {
  name: 'Ohne Konten',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/accounts', () => HttpResponse.json({ items: [] })),
        ...assignmentHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
