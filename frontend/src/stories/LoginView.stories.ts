import type { Meta, StoryObj } from '@storybook/vue3'
import LoginView from '../views/LoginView.vue'
import { defaultHandlers } from './handlers'

const meta: Meta<typeof LoginView> = {
  title: 'Views/LoginView',
  component: LoginView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof LoginView>

export const Default: Story = {
  name: 'Login-Formular',
}
