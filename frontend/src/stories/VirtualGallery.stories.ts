import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import VirtualGallery from '../components/VirtualGallery.vue'
import type { GalleryGridEntry, OrientationVariants } from '../api/gallery'
import { defaultHandlers } from './handlers'
import { MOCK_PHOTOS } from './mock-data'

/**
 * The virtualized photo grid with format pairs
 * (.claude/plans/orientierungs-varianten.md): the same motif in portrait and
 * landscape. The grid asks the server for the side that fits the screen, so
 * the stories pin the viewport and answer the request from a fixture that
 * knows both sides. The shown tile carries the ↻ badge; next to an open
 * stack's `+N` the two sit in the same corner.
 */

const PAIR: OrientationVariants = { portrait: 1, landscape: 1, portrait_ids: [2], landscape_ids: [1] }
const TRIPLE: OrientationVariants = { portrait: 2, landscape: 1, portrait_ids: [4, 5], landscape_ids: [3] }

function entry(
  photo: { id: number; filename: string },
  orientation: 'portrait' | 'landscape' | null,
  group?: GalleryGridEntry['group'],
): GalleryGridEntry {
  return { id: photo.id, filename: photo.filename, curation: 'visible', orientation, group }
}

// A reviewed pair (badge only) and an open stack with both formats (+N and
// badge side by side), plus two frames without a counterpart.
const ALL: GalleryGridEntry[] = [
  entry(MOCK_PHOTOS[0]!, 'landscape', { id: 1, is_cover: true, member_count: 2, reviewed: true, variants: PAIR }),
  entry(MOCK_PHOTOS[1]!, 'portrait', { id: 1, is_cover: false, member_count: 2, reviewed: true, variants: PAIR }),
  entry(MOCK_PHOTOS[2]!, 'landscape', { id: 2, is_cover: true, member_count: 3, reviewed: false, variants: TRIPLE }),
  entry(MOCK_PHOTOS[3]!, 'portrait', { id: 2, is_cover: false, member_count: 3, reviewed: false, variants: TRIPLE }),
  entry(MOCK_PHOTOS[4]!, 'portrait', { id: 2, is_cover: false, member_count: 3, reviewed: false, variants: TRIPLE }),
  entry({ id: 6, filename: 'extra-a.jpg' }, 'landscape'),
  entry({ id: 7, filename: 'extra-b.jpg' }, null),
]

/** Answers like the backend: only the side that fits, cover moved along. */
function gridHandler() {
  return http.get('/api/gallery/grid', ({ request }) => {
    const mode = new URL(request.url).searchParams.get('variantMode') ?? 'all'
    const photos = ALL.filter((e) => {
      const v = e.group?.variants
      if (!v || mode === 'all') return true
      const hidden = mode === 'portrait' ? v.landscape_ids : v.portrait_ids
      return !hidden.includes(e.id)
    }).map((e) => {
      const v = e.group?.variants
      if (!e.group || !v || mode === 'all') return e
      const shown = mode === 'portrait' ? v.portrait_ids : v.landscape_ids
      return { ...e, group: { ...e.group, is_cover: e.id === shown[0] } }
    })
    return HttpResponse.json({ total: photos.length, offset: 0, photos })
  })
}

const meta: Meta<typeof VirtualGallery> = {
  title: 'Components/VirtualGallery',
  component: VirtualGallery,
  parameters: {
    msw: { handlers: [gridHandler(), ...defaultHandlers] },
  },
  args: {
    filter: {},
    sortBy: 'taken_at',
    sortDir: 'asc',
  },
  render: (args) => ({
    components: { VirtualGallery },
    setup: () => ({ args }),
    template: '<div style="height: 100vh"><VirtualGallery v-bind="args" /></div>',
  }),
}

export default meta
type Story = StoryObj<typeof VirtualGallery>

export const FormatpaareQuer: Story = {
  name: 'Formatpaare (Querformat-Bildschirm)',
  parameters: { testViewport: { width: 1280, height: 800 } },
}

export const FormatpaareHochkant: Story = {
  name: 'Formatpaare (Hochformat-Bildschirm)',
  parameters: { testViewport: { width: 390, height: 844 } },
}

export const FormatvariantenAnzeigen: Story = {
  name: 'Formatvarianten anzeigen (beide Seiten)',
  parameters: { testViewport: { width: 1280, height: 800 } },
  args: { filter: { showVariants: true } },
}

export const Auswahlmodus: Story = {
  name: 'Auswahlmodus (zeigt alles)',
  parameters: { testViewport: { width: 390, height: 844 } },
  args: { selectMode: true, selectedIds: new Set([2]) },
}
