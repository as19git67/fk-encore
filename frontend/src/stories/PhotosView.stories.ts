import type { Meta, StoryObj } from '@storybook/vue3'
import PhotosView from '../views/PhotosView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_PHOTOS, MOCK_GROUP, MOCK_SERVICES_DEGRADED, MOCK_SERVER_PRESSURE_OK } from './mock-data'

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
        http.get('/api/photos/index', () =>
          HttpResponse.json({
            photos: MOCK_PHOTOS.filter((p) => p.curation_status !== 'hidden'),
          }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const MitGruppe: Story = {
  name: 'Mit Foto-Gruppen (Vergleich)',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos/groups', () =>
          HttpResponse.json({ groups: [MOCK_GROUP] }),
        ),
        http.get('/api/photos/groups/next-unreviewed', () =>
          HttpResponse.json(MOCK_GROUP),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const DiensteOffline: Story = {
  name: 'Externe Dienste offline',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos/service-health', () =>
          HttpResponse.json({
            services: MOCK_SERVICES_DEGRADED,
            serverPressure: MOCK_SERVER_PRESSURE_OK,
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
        http.get('/api/photos/index', () => HttpResponse.json({ photos: [] })),
        http.get('/api/photos', () => HttpResponse.json({ photos: [] })),
        ...defaultHandlers,
      ],
    },
  },
}
