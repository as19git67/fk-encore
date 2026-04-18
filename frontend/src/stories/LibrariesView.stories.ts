import type { Meta, StoryObj } from '@storybook/vue3'
import LibrariesView from '../views/LibrariesView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_AVAILABLE_PATHS } from './mock-data'

const meta: Meta<typeof LibrariesView> = {
  title: 'Views/LibrariesView',
  component: LibrariesView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof LibrariesView>

export const MitBibliotheken: Story = {
  name: 'Externe Bibliotheken',
}

export const Leer: Story = {
  name: 'Keine Bibliotheken konfiguriert',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/libraries', () => HttpResponse.json({ libraries: [] })),
        ...defaultHandlers,
      ],
    },
  },
}

export const RootNichtGemountet: Story = {
  name: 'PHOTO_LIBRARIES_ROOT nicht gemountet',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/libraries', () => HttpResponse.json({ libraries: [] })),
        http.get('/api/libraries/available-paths', () =>
          HttpResponse.json({
            ...MOCK_AVAILABLE_PATHS,
            root_mounted: false,
            current_mounted: false,
            directories: [],
          }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}
