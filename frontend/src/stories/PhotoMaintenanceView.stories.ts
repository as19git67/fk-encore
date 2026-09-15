import type { Meta, StoryObj } from '@storybook/vue3'
import PhotoMaintenanceView from '../views/PhotoMaintenanceView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { withPermissions } from './storyPermissions'

const meta: Meta<typeof PhotoMaintenanceView> = {
  title: 'Views/PhotoMaintenanceView',
  component: PhotoMaintenanceView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof PhotoMaintenanceView>

export const Default: Story = {
  name: 'Foto-Wartung',
}

export const GpsRescanAvailable: Story = {
  name: 'Fotos für GPS-Rescan verfügbar',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos/needs-gps-rescan', () =>
          HttpResponse.json({ ids: [1, 2, 3, 4] }),
        ),
        http.get('/api/photos/refresh-metadata', () =>
          HttpResponse.json({ ids: [5, 6] }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const OhneMetadatenRecht: Story = {
  name: 'Ohne photos.refresh_metadata (Karte fehlt)',
  decorators: [withPermissions(['photos.view', 'data.manage'])],
}
