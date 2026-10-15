import type { Meta, StoryObj } from '@storybook/vue3'
import SaveRuleDialog from '../components/collections/SaveRuleDialog.vue'
import { defaultHandlers } from './handlers'

/**
 * A list's filter saved as a rule collection (#1548, stage 5): the gallery
 * and the transaction list offer it while a filter is set.
 */
const meta: Meta<typeof SaveRuleDialog> = {
  title: 'Components/SaveRuleDialog',
  component: SaveRuleDialog,
  parameters: { msw: { handlers: defaultHandlers } },
  args: {
    visible: true,
    rule: { type: 'transaction', criteria: { text: 'Stadtwerke', tags: ['Nebenkosten'] } },
    summary: '„Stadtwerke“ · Tag: Nebenkosten',
  },
}

export default meta
type Story = StoryObj<typeof SaveRuleDialog>

export const Buchungen: Story = {}

export const Fotos: Story = {
  args: { rule: { type: 'photo', filter: { dateFrom: '2025-06-01', dateTo: '2025-08-31' } }, summary: 'Datum: 01.06.2025 – 31.08.2025' },
}
