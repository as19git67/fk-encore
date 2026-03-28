import type { Meta, StoryObj } from '@storybook/vue3'
import PersonsView from '../views/PersonsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'

const meta: Meta<typeof PersonsView> = {
  title: 'Views/PersonsView',
  component: PersonsView,
}

export default meta
type Story = StoryObj<typeof PersonsView>

export const MitPersonen: Story = {
  name: 'Mit erkannten Personen',
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export const Leer: Story = {
  name: 'Keine Personen',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/persons', () =>
          HttpResponse.json({ persons: [], enableLocalFaces: false }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}
