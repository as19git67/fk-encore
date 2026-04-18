import type { Meta, StoryObj } from '@storybook/vue3'
import DataManagementView from '../views/DataManagementView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_SCAN_QUEUE_BUSY } from './mock-data'

const meta: Meta<typeof DataManagementView> = {
  title: 'Views/DataManagementView',
  component: DataManagementView,
}

export default meta
type Story = StoryObj<typeof DataManagementView>

export const Default: Story = {
  name: 'Datenverwaltung (Leerlauf)',
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export const ScanQueueBusy: Story = {
  name: 'Scan-Warteschlange aktiv',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos/scan-queue/status', () => HttpResponse.json(MOCK_SCAN_QUEUE_BUSY)),
        ...defaultHandlers,
      ],
    },
  },
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
