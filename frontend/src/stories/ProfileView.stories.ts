import type { Meta, StoryObj } from '@storybook/vue3'
import ProfileView from '../views/ProfileView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'

const meta: Meta<typeof ProfileView> = {
  title: 'Views/ProfileView',
  component: ProfileView,
}

export default meta
type Story = StoryObj<typeof ProfileView>

export const MitPasskeys: Story = {
  name: 'Mit Passkeys',
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export const OhnePasskeys: Story = {
  name: 'Keine Passkeys',
  parameters: {
    msw: {
      handlers: [
        ...defaultHandlers,
        http.get('/api/auth/passkeys', () => HttpResponse.json({ passkeys: [] })),
      ],
    },
  },
}
