import type { Meta, StoryObj } from '@storybook/vue3'
import PhotosView from '../views/PhotosView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_PHOTOS } from './mock-data'

const meta: Meta<typeof PhotosView> = {
  title: 'Views/PhotosView',
  component: PhotosView,
}

export default meta
type Story = StoryObj<typeof PhotosView>

export const MitFotos: Story = {
  name: 'Galerie mit Fotos',
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export const NurSichtbare: Story = {
  name: 'Nur sichtbare Fotos',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos', () =>
          HttpResponse.json({
            photos: MOCK_PHOTOS.filter((p) => p.curation_status !== 'hidden'),
          }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const Leer: Story = {
  name: 'Keine Fotos',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos', () => HttpResponse.json({ photos: [] })),
        ...defaultHandlers,
      ],
    },
  },
}
