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
