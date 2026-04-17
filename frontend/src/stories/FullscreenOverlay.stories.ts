import type { Meta, StoryObj } from '@storybook/vue3'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import { defaultHandlers } from './handlers'
import { MOCK_PHOTOS } from './mock-data'

const meta: Meta<typeof FullscreenOverlay> = {
  title: 'Components/FullscreenOverlay',
  component: FullscreenOverlay,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
  args: {
    canDelete: true,
    showDetailsButton: true,
    detailsActive: false,
  },
}

export default meta
type Story = StoryObj<typeof FullscreenOverlay>

export const MitNavigation: Story = {
  name: 'Mit Vor/Zurück',
  args: {
    photo: MOCK_PHOTOS[0]!,
    prevPhoto: null,
    nextPhoto: MOCK_PHOTOS[1]!,
  },
}

export const InDerMitte: Story = {
  name: 'In der Mitte einer Serie',
  args: {
    photo: MOCK_PHOTOS[2]!,
    prevPhoto: MOCK_PHOTOS[1]!,
    nextPhoto: MOCK_PHOTOS[3]!,
  },
}

export const EinzelbildFavorit: Story = {
  name: 'Einzelbild (Favorit)',
  args: {
    photo: MOCK_PHOTOS[1]!,
    prevPhoto: null,
    nextPhoto: null,
  },
}

export const AusgeblendetesFoto: Story = {
  name: 'Ausgeblendetes Foto',
  args: {
    photo: MOCK_PHOTOS[4]!,
    prevPhoto: MOCK_PHOTOS[3]!,
    nextPhoto: null,
  },
}

export const DetailsAktiv: Story = {
  name: 'Detail-Flyout offen',
  args: {
    photo: MOCK_PHOTOS[0]!,
    prevPhoto: null,
    nextPhoto: MOCK_PHOTOS[1]!,
    detailsActive: true,
  },
}

export const OhneLoeschrechte: Story = {
  name: 'Ohne Löschrechte',
  args: {
    photo: MOCK_PHOTOS[0]!,
    prevPhoto: null,
    nextPhoto: null,
    canDelete: false,
  },
}
