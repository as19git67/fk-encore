import type { Meta, StoryObj } from '@storybook/vue3'
import OsmRegionsView from '../views/OsmRegionsView.vue'
import { defaultHandlers } from './handlers'

const meta: Meta<typeof OsmRegionsView> = {
  title: 'Views/OsmRegionsView',
  component: OsmRegionsView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof OsmRegionsView>

export const Leer: Story = {
  name: 'Noch keine Regionen angelegt',
}
