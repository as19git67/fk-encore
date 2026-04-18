import type { Meta, StoryObj } from '@storybook/vue3'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import { defaultHandlers } from './handlers'
import { MOCK_PHOTOS, MOCK_FACES, MOCK_LANDMARKS, MOCK_PERSONS } from './mock-data'

const meta: Meta<typeof PhotoDetailSidebar> = {
  title: 'Components/PhotoDetailSidebar',
  component: PhotoDetailSidebar,
  decorators: [
    (story) => ({
      components: { Story: story() },
      template: '<div style="max-width: 420px; padding: 1rem;"><Story /></div>',
    }),
  ],
  parameters: {
    msw: { handlers: defaultHandlers },
  },
  args: {
    canDelete: true,
    canUpload: true,
    reindexingPhoto: false,
    isEditingDate: false,
    updatingDate: false,
    faces: [],
    loadingFaces: false,
    landmarks: [],
    loadingLandmarks: false,
    persons: MOCK_PERSONS,
    showPersons: true,
    limitAlbumsShown: false,
    albumRole: 'owner',
    faceServiceAvailable: true,
  },
}

export default meta
type Story = StoryObj<typeof PhotoDetailSidebar>

export const FotoMitOrt: Story = {
  name: 'Foto mit Ort (GPS)',
  args: {
    photo: MOCK_PHOTOS[0]!,
    faces: MOCK_FACES,
    landmarks: MOCK_LANDMARKS,
  },
}

export const FotoOhneGps: Story = {
  name: 'Foto ohne GPS-Daten',
  args: {
    photo: MOCK_PHOTOS[1]!,
  },
}

export const LaedtGesichter: Story = {
  name: 'Gesichter werden geladen',
  args: {
    photo: MOCK_PHOTOS[0]!,
    loadingFaces: true,
    loadingLandmarks: true,
  },
}

export const GesichtserkennungOffline: Story = {
  name: 'Gesichtserkennung offline',
  args: {
    photo: MOCK_PHOTOS[0]!,
    faces: MOCK_FACES,
    faceServiceAvailable: false,
  },
}

export const NurBetrachter: Story = {
  name: 'Nur Betrachter (read-only)',
  args: {
    photo: MOCK_PHOTOS[0]!,
    faces: MOCK_FACES,
    canDelete: false,
    canUpload: false,
    albumRole: 'viewer',
  },
}

export const InFlyout: Story = {
  name: 'Eingebettet im Fullscreen-Flyout',
  args: {
    photo: MOCK_PHOTOS[0]!,
    faces: MOCK_FACES,
    landmarks: MOCK_LANDMARKS,
    inFlyout: true,
  },
}
