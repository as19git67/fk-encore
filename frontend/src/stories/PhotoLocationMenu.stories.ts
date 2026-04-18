import type { Meta, StoryObj } from '@storybook/vue3'
import PhotoLocationMenu from '../components/PhotoLocationMenu.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'

const meta: Meta<typeof PhotoLocationMenu> = {
  title: 'Components/PhotoLocationMenu',
  component: PhotoLocationMenu,
  decorators: [
    (story) => ({
      components: { Story: story() },
      template:
        '<div style="padding: 4rem; display: flex; gap: 1rem; align-items: center;">' +
        '<span>Klicke rechts auf das Icon:</span><Story />' +
        '</div>',
    }),
  ],
  args: {
    photoId: 1,
  },
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof PhotoLocationMenu>

export const MehrereFundorte: Story = {
  name: 'Foto in mehreren Alben + Galerie',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos/:id/locations', () =>
          HttpResponse.json({
            photoId: 1,
            albums: [
              { id: 1, name: 'Städtereise München' },
              { id: 2, name: 'Schlösser & Burgen' },
            ],
            persons: [],
            hasGps: true,
          }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const NurGalerie: Story = {
  name: 'Nur in "Alle Fotos" (springt direkt)',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos/:id/locations', () =>
          HttpResponse.json({
            photoId: 1, albums: [], persons: [], hasGps: false,
          }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const AlleFotosAusblenden: Story = {
  name: 'Ausgehend von Galerie (All-Photos ausgeblendet)',
  args: { excludeAllPhotos: true },
}
