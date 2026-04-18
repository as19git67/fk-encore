import type { Meta, StoryObj } from '@storybook/vue3'
import AlbumsView from '../views/AlbumsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'

const meta: Meta<typeof AlbumsView> = {
  title: 'Views/AlbumsView',
  component: AlbumsView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof AlbumsView>

export const MitAlben: Story = {
  name: 'Alben-Übersicht',
}

export const Leer: Story = {
  name: 'Keine Alben',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/albums', () => HttpResponse.json({ albums: [] })),
        ...defaultHandlers,
      ],
    },
  },
}
