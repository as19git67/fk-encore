import type { Meta, StoryObj } from '@storybook/vue3'
import DocumentsHelpView from '../views/DocumentsHelpView.vue'
import BankcontactsHelpView from '../views/finance/BankcontactsHelpView.vue'
import MeterDegreeDaysHelpView from '../views/MeterDegreeDaysHelpView.vue'
import { defaultHandlers } from './handlers'
import { routeFromParameters } from './storyRoute'

/**
 * The three explanatory pages (issue #1281). They load nothing, so each has
 * exactly one state worth keeping — but they are long text pages, and that
 * is precisely what the overflow and focus-ring guards need to see at phone
 * width as well as on a wide screen.
 */
const meta: Meta = {
  title: 'Views/Hilfeseiten',
  parameters: { msw: { handlers: defaultHandlers } },
}

export default meta
type Story = StoryObj

export const DokumenteHilfe: Story = {
  name: 'Dokumente · Hilfe',
  decorators: [routeFromParameters('/dokumente/hilfe')],
  render: () => ({ components: { DocumentsHelpView }, template: '<DocumentsHelpView />' }),
}

export const DokumenteHilfeTelefon: Story = {
  name: 'Dokumente · Hilfe (Telefonbreite)',
  decorators: [routeFromParameters('/dokumente/hilfe')],
  parameters: { testViewport: { width: 360, height: 740 } },
  render: () => ({ components: { DocumentsHelpView }, template: '<DocumentsHelpView />' }),
}

export const BankkontakteHilfe: Story = {
  name: 'Bankkontakte · Hilfe',
  decorators: [routeFromParameters('/finanzen/bankkontakte/hilfe')],
  render: () => ({ components: { BankcontactsHelpView }, template: '<BankcontactsHelpView />' }),
}

export const GradtageHilfe: Story = {
  name: 'Zähler · Gradtage',
  decorators: [routeFromParameters('/zaehler/hilfe/gradtage')],
  render: () => ({
    components: { MeterDegreeDaysHelpView },
    template: '<MeterDegreeDaysHelpView />',
  }),
}
