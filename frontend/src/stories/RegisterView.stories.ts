import type { Meta, StoryObj } from '@storybook/vue3'
import RegisterView from '../views/RegisterView.vue'
import { defaultHandlers } from './handlers'

const meta: Meta<typeof RegisterView> = {
  title: 'Views/RegisterView',
  component: RegisterView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof RegisterView>

export const Default: Story = {
  name: 'Registrierung',
}
