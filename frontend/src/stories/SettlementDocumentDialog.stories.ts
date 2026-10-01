import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import SettlementDocumentDialog from '../components/finance/SettlementDocumentDialog.vue'
import { defaultHandlers } from './handlers'
import { MOCK_SETTLEMENT_INSPECTION, MOCK_SETTLEMENT_INSPECTION_REJECTED } from './finance-mock-data'

/** A settlement document with what the parser read from it (issue #1336). */

const meta: Meta<typeof SettlementDocumentDialog> = {
  title: 'Finance/SettlementDocumentDialog',
  component: SettlementDocumentDialog,
  args: { documentId: 305, canApply: true },
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/portfolio/documents/:id/inspection', () => HttpResponse.json(MOCK_SETTLEMENT_INSPECTION)),
        ...defaultHandlers,
      ],
    },
  },
}

export default meta
type Story = StoryObj<typeof SettlementDocumentDialog>

export const Abweichung: Story = { name: 'Erkannt, Betrag weicht ab' }

export const KeineAbrechnung: Story = {
  name: 'Keine Abrechnung',
  args: { documentId: 306 },
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/portfolio/documents/:id/inspection', () => HttpResponse.json(MOCK_SETTLEMENT_INSPECTION_REJECTED)),
        ...defaultHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
