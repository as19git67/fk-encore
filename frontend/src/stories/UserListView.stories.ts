import type { Meta, StoryObj } from '@storybook/vue3'
import UserListView from '../views/UserListView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_USERS } from './mock-data'

const meta: Meta<typeof UserListView> = {
  title: 'Views/UserListView',
  component: UserListView,
}

export default meta
type Story = StoryObj<typeof UserListView>

export const MitBenutzern: Story = {
  name: 'Mit Benutzern',
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export const Leer: Story = {
  name: 'Leere Liste',
  parameters: {
    msw: {
      handlers: [
        ...defaultHandlers,
        http.get('/api/users', () => HttpResponse.json({ users: [] })),
      ],
    },
  },
}

export const EinBenutzer: Story = {
  name: 'Ein Benutzer',
  parameters: {
    msw: {
      handlers: [
        ...defaultHandlers,
        http.get('/api/users', () => HttpResponse.json({ users: [MOCK_USERS[0]!] })),
      ],
    },
  },
}
