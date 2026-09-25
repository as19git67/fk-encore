import type { Meta, StoryObj } from '@storybook/vue3'
import ForecastStatementsDialog from '../components/finance/forecast/ForecastStatementsDialog.vue'
import { defaultHandlers } from './handlers'
import { routeFromParameters } from './storyRoute'
import { STATEMENTS } from './forecastStatementsFixture'
import type { ForecastItem, ForecastItemStatements } from '../api/finance'

const [WITH_DIFF, NO_DOCUMENT] = STATEMENTS as [ForecastItemStatements, ForecastItemStatements]

/**
 * Standmitteilungen of one forecast item (#1343). Contract, documents and
 * values are invented.
 */

const ITEM: ForecastItem = {
  id: 106,
  personId: 1,
  type: 'life_insurance',
  label: 'Lebensversicherung Alex',
  data: { surrenderValue: 38000, monthlyPremium: 150, projectedPayout: 62000, guaranteedPayout: 55000, contractNo: 'X-000111' },
  linkedAccountId: null,
  linkedAccountBalance: null,
  sortOrder: 0,
}

const meta: Meta<typeof ForecastStatementsDialog> = {
  title: 'Components/Finance/ForecastStatementsDialog',
  component: ForecastStatementsDialog,
  decorators: [routeFromParameters('/finanzen/prognose')],
  parameters: { msw: { handlers: defaultHandlers } },
  args: { visible: true, item: ITEM, state: WITH_DIFF },
}

export default meta
type Story = StoryObj<typeof ForecastStatementsDialog>

export const MitAbweichungen: Story = { name: 'Mit Abweichungen' }

export const KeinDokument: Story = {
  name: 'Kein Dokument gefunden',
  args: { state: { ...NO_DOCUMENT, itemId: 106, contractNo: 'X-000111' } },
}

export const Ueberfaellig: Story = {
  name: 'Überfällig',
  args: {
    state: { ...WITH_DIFF, proposals: [], latest: { ...WITH_DIFF.latest!, status: 'accepted', referenceDate: '2024-01-01' }, overdue: true },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
