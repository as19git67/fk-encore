import type { Meta, StoryObj } from '@storybook/vue3'
import SystemStatusView from '../views/SystemStatusView.vue'
import { defaultHandlers } from './handlers'
import { withPermissions } from './storyPermissions'

const meta: Meta<typeof SystemStatusView> = {
  title: 'Views/SystemStatusView',
  component: SystemStatusView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof SystemStatusView>

export const AlleWarteschlangen: Story = {
  name: 'Alle Warteschlangen sichtbar',
}

export const NurDokumente: Story = {
  name: 'Nur das Dokumente-Modul freigeschaltet',
  decorators: [withPermissions(['documents.view', 'data.manage'])],
}
