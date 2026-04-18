import type { Meta, StoryObj } from '@storybook/vue3'
import TripMap from '../components/TripMap.vue'
import { defaultHandlers } from './handlers'
import { MOCK_PHOTOS } from './mock-data'
import type { Photo } from '../api/photos'

const meta: Meta<typeof TripMap> = {
  title: 'Components/TripMap',
  component: TripMap,
  decorators: [
    (story) => ({
      components: { Story: story() },
      template: '<div style="height: 600px; display: flex;"><Story /></div>',
    }),
  ],
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof TripMap>

// Photos mit GPS-Daten
const photosWithGps: Photo[] = MOCK_PHOTOS.filter(
  (p) => p.latitude !== undefined && p.longitude !== undefined,
)

// Extra-Stops für eine mehrtägige Reise
const tripPhotos: Photo[] = [
  ...photosWithGps,
  {
    id: 101,
    user_id: 1,
    filename: 'museum.jpg',
    original_name: 'Museum-2.jpg',
    mime_type: 'image/jpeg',
    size: 2_000_000,
    taken_at: '2024-03-15T14:20:00Z',
    created_at: '2024-03-15T14:20:00Z',
    curation_status: 'visible',
    latitude: 48.1372,
    longitude: 11.5756,
    location_name: 'Marienplatz',
    location_city: 'München',
    location_country: 'Deutschland',
  },
  {
    id: 102,
    user_id: 1,
    filename: 'castle.jpg',
    original_name: 'Hohenschwangau.jpg',
    mime_type: 'image/jpeg',
    size: 3_000_000,
    taken_at: '2024-03-16T11:00:00Z',
    created_at: '2024-03-16T11:00:00Z',
    curation_status: 'visible',
    latitude: 47.5572,
    longitude: 10.7372,
    location_name: 'Schloss Hohenschwangau',
    location_city: 'Schwangau',
    location_country: 'Deutschland',
  },
]

export const MehrtaegigeReise: Story = {
  name: 'Mehrtägige Reise',
  args: {
    photos: tripPhotos,
    albumName: 'Bayern-Tour',
    albumDescription: 'Ein Wochenende durch Süddeutschland',
  },
}

export const EinzelnerOrt: Story = {
  name: 'Einzelner Ort',
  args: {
    photos: photosWithGps.slice(0, 1),
    albumName: 'München',
  },
}

export const MitFotosOhneGps: Story = {
  name: 'Mit Fotos ohne GPS-Daten',
  args: {
    photos: [...tripPhotos, MOCK_PHOTOS[1]!, MOCK_PHOTOS[4]!],
    albumName: 'Gemischtes Album',
  },
}
