import type { Meta, StoryObj } from '@storybook/vue3'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import { defaultHandlers } from './handlers'
import { MOCK_PHOTOS, MOCK_FACES, MOCK_PERSONS } from './mock-data'

// Phone viewports used to exercise the split-detail layout. The split's
// portrait/landscape branch keys off the `(orientation: …)` media query, i.e.
// the iframe aspect ratio, so a wide vs. tall viewport is what flips it.
const phoneViewports = {
  phonePortrait: {
    name: 'Phone Portrait (390×844)',
    styles: { width: '390px', height: '844px' },
  },
  phoneLandscape: {
    name: 'Phone Landscape (844×390)',
    styles: { width: '844px', height: '390px' },
  },
}

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

// Split-detail layout: the details only engage the split when a
// `details-flyout` slot is actually provided (splitMode = detailsActive &&
// hasDetailsSlot). These stories mount the real PhotoDetailSidebar into that
// slot — exactly as GalleryView does — so the split geometry, the
// safe-area-inset topbar and the photo-centered action bar can be verified.
const renderWithSidebar: Story['render'] = (args) => ({
  components: { FullscreenOverlay, PhotoDetailSidebar },
  setup() {
    return {
      args,
      sidebarPhoto: MOCK_PHOTOS[0]!,
      faces: MOCK_FACES,
      persons: MOCK_PERSONS,
    }
  },
  template: `
    <FullscreenOverlay v-bind="args">
      <template #details-flyout>
        <PhotoDetailSidebar
          :photo="sidebarPhoto"
          :faces="faces"
          :persons="persons"
          :can-delete="true"
          :can-upload="true"
          :show-persons="true"
          :limit-albums-shown="true"
          :face-service-available="true"
          :in-flyout="true"
        />
      </template>
    </FullscreenOverlay>
  `,
})

export const SplitPortrait: Story = {
  name: 'Detail-Split (Portrait)',
  render: renderWithSidebar,
  parameters: {
    viewport: { viewports: phoneViewports, defaultViewport: 'phonePortrait' },
    testViewport: { width: 390, height: 844 },
  },
  args: {
    photo: MOCK_PHOTOS[0]!,
    prevPhoto: null,
    nextPhoto: MOCK_PHOTOS[1]!,
    detailsActive: true,
  },
}

export const SplitLandscape: Story = {
  name: 'Detail-Split (Landscape, Spalte gedeckelt)',
  render: renderWithSidebar,
  parameters: {
    viewport: { viewports: phoneViewports, defaultViewport: 'phoneLandscape' },
    testViewport: { width: 844, height: 390 },
  },
  args: {
    photo: MOCK_PHOTOS[0]!,
    prevPhoto: null,
    nextPhoto: MOCK_PHOTOS[1]!,
    detailsActive: true,
  },
}

// Wide landscape (e.g. desktop / tablet): verifies the metadata column stays
// capped at ~402px while the photo absorbs the extra width.
export const SplitLandscapeWide: Story = {
  name: 'Detail-Split (breit, Spalte bleibt 402px)',
  render: renderWithSidebar,
  parameters: {
    testViewport: { width: 1280, height: 720 },
  },
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
