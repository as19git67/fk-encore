import type { Meta, StoryObj } from '@storybook/vue3'
import RolesView from '../views/RolesView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'

const meta: Meta<typeof RolesView> = {
  title: 'Views/RolesView',
  component: RolesView,
}

export default meta
type Story = StoryObj<typeof RolesView>

export const MitRollen: Story = {
  name: 'Mit Rollen',
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export const Leer: Story = {
  name: 'Keine Rollen',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/roles', () => HttpResponse.json({ roles: [] })),
        ...defaultHandlers,
      ],
    },
  },
}
