import type { Meta, StoryObj } from '@storybook/vue3'
import PhotoCompareView from '../components/PhotoCompareView.vue'
import { defaultHandlers } from './handlers'
import { MOCK_PHOTOS, MOCK_GROUP } from './mock-data'
import type { PhotoGroup } from '../api/photos'

const meta: Meta<typeof PhotoCompareView> = {
  title: 'Components/PhotoCompareView',
  component: PhotoCompareView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
  args: {
    allPhotos: MOCK_PHOTOS,
    totalUnreviewed: 3,
  },
}

export default meta
type Story = StoryObj<typeof PhotoCompareView>

// Gruppe mit 3 Fotos – genug für Swiss-system-Vergleich
export const DreiFootos: Story = {
  name: 'Vergleich: 3 Fotos',
  args: {
    group: MOCK_GROUP,
  },
}

// Nur 2 Fotos: ein einziger Vergleich
const twoPhotoGroup: PhotoGroup = {
  id: 2,
  user_id: 1,
  cover_photo_id: 3,
  created_at: '2024-05-10T16:45:00Z',
  member_count: 2,
  photo_ids: [3, 4],
}

export const ZweiFotos: Story = {
  name: 'Vergleich: 2 Fotos',
  args: {
    group: twoPhotoGroup,
    totalUnreviewed: 1,
  },
}

// 5 Fotos – alle verfügbaren Mock-Fotos
const fullGroup: PhotoGroup = {
  id: 3,
  user_id: 1,
  cover_photo_id: 1,
  created_at: '2024-06-01T00:00:00Z',
  member_count: 5,
  photo_ids: [1, 2, 3, 4, 5],
}

export const FuenfFotos: Story = {
  name: 'Vergleich: 5 Fotos',
  args: {
    group: fullGroup,
    totalUnreviewed: 2,
  },
}

// Format pair (.claude/plans/orientierungs-varianten.md): one landscape and
// two portrait frames of the same motif. Only the two portraits duel; the
// review then keeps the landscape frame and the portrait winner as the pair.
const PAIR_PHOTOS = [
  { ...MOCK_PHOTOS[0]!, orientation: 'landscape' as const },
  { ...MOCK_PHOTOS[1]!, orientation: 'portrait' as const },
  { ...MOCK_PHOTOS[2]!, orientation: 'portrait' as const },
  ...MOCK_PHOTOS.slice(3),
]

const pairGroup: PhotoGroup = {
  id: 4,
  user_id: 1,
  cover_photo_id: 1,
  created_at: '2024-06-02T00:00:00Z',
  member_count: 3,
  photo_ids: [1, 2, 3],
  orientation_variants: 'auto',
  variants: { portrait: 2, landscape: 1, portrait_ids: [2, 3], landscape_ids: [1] },
}

export const Formatpaar: Story = {
  name: 'Formatpaar: Duell nur innerhalb der Orientierung',
  args: {
    group: pairGroup,
    allPhotos: PAIR_PHOTOS,
    totalUnreviewed: 1,
  },
}
