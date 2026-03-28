import type { Meta, StoryObj } from '@storybook/vue3'
import DataManagementView from '../views/DataManagementView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'

const meta: Meta<typeof DataManagementView> = {
  title: 'Views/DataManagementView',
  component: DataManagementView,
}

export default meta
type Story = StoryObj<typeof DataManagementView>

export const Default: Story = {
  name: 'Datenverwaltung',
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export const ReindexLaeuft: Story = {
  name: 'Reindex läuft',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos/reindex-status', () =>
          HttpResponse.json({
            inProgress: true,
            total: 5,
            processed: 2,
            errors: 0,
          }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}
