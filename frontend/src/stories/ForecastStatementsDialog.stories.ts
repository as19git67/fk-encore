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

export const ErhoehungAbgelehnt: Story = {
  name: 'Beitragserhöhung abgelehnt',
  args: {
    state: {
      ...WITH_DIFF,
      links: [
        ...WITH_DIFF.links,
        { id: 3, documentId: 503, title: 'Nachtrag Dynamik', docDate: '2026-03-02', documentType: null, matchKind: 'text', status: 'confirmed', kind: 'dynamic_declined', kindByUser: true, canOpen: false },
      ],
      notes: ['Beitrag nicht vorgeschlagen: die Beitragserhöhung wurde abgelehnt (Schreiben vom 02.03.2026).'],
    },
  },
}

export const AbgelehntOhneDokument: Story = {
  name: 'Erhöhung ohne Dokument abgelehnt',
  args: {
    state: {
      ...WITH_DIFF,
      declinedWithoutDocument: ['2026-03-10'],
      notes: ['Beitrag nicht vorgeschlagen: die Beitragserhöhung wurde abgelehnt (ohne Dokument vermerkt, 10.03.2026).'],
      latest: { ...WITH_DIFF.latest!, method: 'user' },
    },
  },
}

export const Buchungen: Story = {
  name: 'Sachversicherung mit Buchungen',
  args: {
    item: { ...ITEM, id: 120, type: 'expense', label: 'Rechtsschutz', data: { amount: 22, frequency: 'monthly', insurer: 'Musterschutz AG' } },
    state: {
      ...NO_DOCUMENT,
      itemId: 120,
      contractNo: null,
      bookings: {
        bookings: [
          { id: 11, transactionId: 901, date: '2026-09-01', amount: -26, counterparty: 'MUSTERSCHUTZ AG', purpose: 'Beitrag', matchKind: 'counterparty', status: 'confirmed' },
          { id: 12, transactionId: 902, date: '2026-08-01', amount: -26, counterparty: 'MUSTERSCHUTZ AG', purpose: 'Beitrag', matchKind: 'counterparty', status: 'confirmed' },
          { id: 13, transactionId: 903, date: '2026-07-01', amount: -26, counterparty: 'MUSTERSCHUTZ AG', purpose: 'Beitrag', matchKind: 'counterparty', status: 'suggested' },
        ],
        summary: { rhythm: 'monthly', perYearCount: 12, lastAmount: 26, lastDate: '2026-09-01', perYear: 312, count: 2 },
        proposal: { field: 'amount', label: 'Beitrag pro Monat', kind: 'amount', current: 22, proposed: 26 },
        contractNoSuggestion: 'RS-0000-0001',
      },
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
