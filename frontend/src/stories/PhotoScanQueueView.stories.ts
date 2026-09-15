import type { Meta, StoryObj } from '@storybook/vue3'
import PhotoScanQueueView from '../views/PhotoScanQueueView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_SCAN_QUEUE_BUSY } from './mock-data'

const meta: Meta<typeof PhotoScanQueueView> = {
  title: 'Views/PhotoScanQueueView',
  component: PhotoScanQueueView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof PhotoScanQueueView>

export const Idle: Story = {
  name: 'Scan-Queue (Leerlauf)',
}

export const Busy: Story = {
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
