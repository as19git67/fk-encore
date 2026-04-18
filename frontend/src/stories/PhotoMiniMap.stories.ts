import type { Meta, StoryObj } from '@storybook/vue3'
import PhotoMiniMap from '../components/PhotoMiniMap.vue'

const meta: Meta<typeof PhotoMiniMap> = {
  title: 'Components/PhotoMiniMap',
  component: PhotoMiniMap,
  decorators: [
    (story) => ({
      components: { Story: story() },
      template: '<div style="width: 320px; height: 220px;"><Story /></div>',
    }),
  ],
}

export default meta
type Story = StoryObj<typeof PhotoMiniMap>

export const Muenchen: Story = {
  name: 'München (Deutsches Museum)',
  args: {
    latitude: 48.1478,
    longitude: 11.5683,
    label: 'Deutsches Museum, München',
  },
}

export const Neuschwanstein: Story = {
  name: 'Schloss Neuschwanstein',
  args: {
    latitude: 47.5576,
    longitude: 10.7498,
    label: 'Schloss Neuschwanstein',
  },
}

export const OhneLabel: Story = {
  name: 'Nur Koordinaten',
  args: {
    latitude: 53.5413,
    longitude: 9.9833,
  },
}
