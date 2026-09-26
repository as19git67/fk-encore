import type { Meta, StoryObj } from '@storybook/vue3'
import ForecastAccountsDialog from '../components/finance/forecast/ForecastAccountsDialog.vue'
import { defaultHandlers } from './handlers'

/** Savings and depot accounts to take into the forecast. Accounts and balances are invented. */

const meta: Meta<typeof ForecastAccountsDialog> = {
  title: 'Components/Finance/ForecastAccountsDialog',
  component: ForecastAccountsDialog,
  parameters: { msw: { handlers: defaultHandlers } },
  args: {
    visible: true,
    persons: [
      { id: 1, label: 'Alex', birthDate: '1970-04-01', sortOrder: 0 },
      { id: 2, label: 'Kim', birthDate: '1973-09-01', sortOrder: 1 },
    ],
    accounts: [
      { id: 5, label: 'Festgeld Beispielbank', balance: 15000, kind: 'festgeld' },
      { id: 6, label: 'Bausparvertrag Beispiel', balance: 8200, kind: 'bausparen' },
      { id: 7, label: 'Depot Beispielbank', balance: 64250.5, kind: 'depot' },
    ],
  },
}

export default meta
type Story = StoryObj<typeof ForecastAccountsDialog>

export const Vorschlaege: Story = { name: 'Vorschläge' }

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
