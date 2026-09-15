import type { Meta, StoryObj } from '@storybook/vue3'
import TagQueueView from '../views/finance/TagQueueView.vue'
import { defaultHandlers } from './handlers'

const meta: Meta<typeof TagQueueView> = {
  title: 'Views/FinanceTagQueueView',
  component: TagQueueView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof TagQueueView>

export const Default: Story = {
  name: 'Finance KI-Tagging',
}
