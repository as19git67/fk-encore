import type { Meta, StoryObj } from '@storybook/vue3'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import { defaultHandlers } from './handlers'
import { MOCK_PHOTOS, MOCK_FACES, MOCK_PERSONS } from './mock-data'
import { faceBoxStyle } from '../utils/faceBbox'

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

/**
 * The yellow face rectangle over the fullscreen photo, as PersonsView draws
 * it. The bbox is normalized against the *photo*, so the rectangle has to
 * line up with the rendered picture — not with the box the picture is
 * letterboxed into. The play function measures exactly that: where the
 * rendered image actually is (from its natural aspect ratio inside its own
 * box) versus where the rectangle sits.
 *
 * The mock photo is 4:3 while the viewport is 16:9, so the picture is
 * letterboxed left and right — the case the user reported as "das Rechteck
 * ist horizontal versetzt".
 */
const FACE_BBOX = { x: 0.25, y: 0.3, width: 0.2, height: 0.25 }

export const Gesichtsrechteck: Story = {
  name: 'Mit Gesichtsrechteck (4:3 in 16:9)',
  parameters: { testViewport: { width: 1280, height: 720 } },
  args: {
    photo: { ...MOCK_PHOTOS[0]!, filename: 'hochformat-test.jpg' },
    prevPhoto: null,
    nextPhoto: null,
  },
  render: (args) => ({
    components: { FullscreenOverlay },
    setup: () => ({
      args,
      // Same geometry the views use, with PersonsView's own look inlined so
      // the story needs no stylesheet of its own.
      boxStyle: {
        ...faceBoxStyle(FACE_BBOX),
        position: 'absolute',
        border: '3px solid var(--p-yellow-500)',
        boxSizing: 'border-box',
        pointerEvents: 'none',
        zIndex: '2',
      },
    }),
    template: `
      <FullscreenOverlay v-bind="args">
        <div class="face-box-story" :style="boxStyle" />
      </FullscreenOverlay>
    `,
  }),
  play: async () => {
    // The overlay teleports out of the story canvas, so measure in the document.
    await expectFaceBoxOnImage(document.body)
  },
}

async function expectFaceBoxOnImage(root: HTMLElement) {
  const box = await waitFor(() => root.querySelector<HTMLElement>('.face-box-story'))
  const img = await waitFor(() =>
    Array.from(root.querySelectorAll('img')).find(
      (i) => i.complete && i.naturalWidth > 0 && i.clientWidth > 0,
    ),
  )
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

  // Where the picture really is: object-fit contain inside the img box.
  const r = img.getBoundingClientRect()
  const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight)
  const w = img.naturalWidth * scale
  const h = img.naturalHeight * scale
  const imageLeft = r.left + (r.width - w) / 2
  const imageTop = r.top + (r.height - h) / 2

  const b = box.getBoundingClientRect()
  const dx = b.left - (imageLeft + FACE_BBOX.x * w)
  const dy = b.top - (imageTop + FACE_BBOX.y * h)
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
    throw new Error(
      `face box off the photo by dx=${dx.toFixed(1)}px dy=${dy.toFixed(1)}px ` +
        `(picture ${w.toFixed(0)}×${h.toFixed(0)} in a ${r.width.toFixed(0)}×${r.height.toFixed(0)} box)`,
    )
  }
}

async function waitFor<T>(read: () => T | null | undefined, timeoutMs = 5000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the element')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
