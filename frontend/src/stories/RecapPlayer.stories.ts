import type { Meta, StoryObj } from '@storybook/vue3'
import RecapPlayer from '../components/RecapPlayer.vue'
import type { Photo } from '../api/photos'

function makePhoto(id: number, minuteOffset: number): Photo {
  const d = new Date('2024-07-20T10:00:00Z')
  d.setMinutes(d.getMinutes() + minuteOffset)
  return {
    id,
    user_id: 1,
    filename: `photo-${id}.jpg`,
    original_name: `Photo ${id}.jpg`,
    mime_type: 'image/jpeg',
    size: 2_000_000,
    taken_at: d.toISOString(),
    created_at: d.toISOString(),
    curation_status: 'visible',
  }
}

const RECAP_PHOTOS: Photo[] = Array.from({ length: 12 }, (_, i) =>
  makePhoto(100 + i, i * 15),
)

const meta: Meta<typeof RecapPlayer> = {
  title: 'Components/RecapPlayer',
  component: RecapPlayer,
  args: {
    photos: RECAP_PHOTOS,
    title: 'Sommerurlaub',
    subtitle: 'Juli 2024 · München',
    open: true,
    durationMs: 60000,
  },
}

export default meta
type Story = StoryObj<typeof RecapPlayer>

export const Landscape: Story = {
  name: 'Collage (Landscape)',
  parameters: {
    testViewport: { width: 844, height: 390 },
  },
}

export const Portrait: Story = {
  name: 'Collage (Portrait)',
  parameters: {
    testViewport: { width: 390, height: 844 },
  },
}
