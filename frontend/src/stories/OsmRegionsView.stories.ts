import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import OsmRegionsView from '../views/OsmRegionsView.vue'
import { defaultHandlers } from './handlers'

const meta: Meta<typeof OsmRegionsView> = {
  title: 'Views/OsmRegionsView',
  component: OsmRegionsView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof OsmRegionsView>

const REGIONS = [
  {
    slug: 'europe/germany/bayern',
    geofabrikUrl: 'https://example.test/bayern-latest.osm.pbf',
    pbfSizeMb: 1240,
    postgresDb: 'osm_bayern',
    bbox: { minLat: 47.2, minLon: 8.9, maxLat: 50.6, maxLon: 13.9 },
    status: 'ready_running',
    lastUsedAt: '2026-09-18T10:00:00Z',
    importedAt: '2026-09-01T08:00:00Z',
    replicationSeq: '4711',
    lastError: null,
    createdAt: '2026-09-01T07:00:00Z',
    updatedAt: '2026-09-18T10:00:00Z',
  },
  {
    slug: 'europe/germany/baden-wuerttemberg',
    geofabrikUrl: 'https://example.test/bw-latest.osm.pbf',
    pbfSizeMb: 980,
    postgresDb: 'osm_bw',
    bbox: { minLat: 47.5, minLon: 7.5, maxLat: 49.8, maxLon: 10.5 },
    status: 'pending_approval',
    lastUsedAt: null,
    importedAt: null,
    replicationSeq: null,
    lastError: null,
    createdAt: '2026-09-17T09:00:00Z',
    updatedAt: '2026-09-17T09:00:00Z',
  },
  {
    slug: 'europe/austria',
    geofabrikUrl: 'https://example.test/austria-latest.osm.pbf',
    pbfSizeMb: 720,
    postgresDb: 'osm_austria',
    bbox: { minLat: 46.3, minLon: 9.5, maxLat: 49.1, maxLon: 17.2 },
    status: 'failed',
    lastUsedAt: '2026-08-30T12:00:00Z',
    importedAt: null,
    replicationSeq: null,
    lastError: 'osm2pgsql brach mit Exit-Code 1 ab: nicht genug Speicher beim Node-Cache',
    createdAt: '2026-08-29T12:00:00Z',
    updatedAt: '2026-08-30T12:00:00Z',
  },
]

const BULK_RESULT = {
  geotaggedPhotoCount: 18432,
  unmappedPhotoCount: 27,
  coveredPhotoCount: 15980,
  suggestions: [
    {
      slug: 'europe/italy/nord-est',
      name: 'Italien Nordost',
      parent: 'europe/italy',
      pbfUrl: 'https://example.test/nord-est-latest.osm.pbf',
      bbox: { minLat: 44.7, minLon: 10.2, maxLat: 47.1, maxLon: 13.9 },
      photoCount: 1420,
      existing: false,
      existingStatus: null,
      coveredByExisting: false,
    },
    {
      slug: 'europe/france/provence-alpes-cote-d-azur',
      name: 'Provence-Alpes-Côte d’Azur',
      parent: 'europe/france',
      pbfUrl: 'https://example.test/paca-latest.osm.pbf',
      bbox: { minLat: 42.9, minLon: 4.2, maxLat: 45.1, maxLon: 7.8 },
      photoCount: 905,
      existing: true,
      existingStatus: 'ready_stopped',
      coveredByExisting: false,
    },
  ],
  redundantRegions: [
    {
      slug: 'europe/germany',
      status: 'ready_running',
      kind: 'superseded_by_children',
      coveringRegions: ['europe/germany/bayern', 'europe/germany/baden-wuerttemberg'],
      selfSizeMb: 4100,
      alternativeSizeMb: 2220,
      recommendation: 'delete',
    },
  ],
}

type Handler = (typeof defaultHandlers)[number]

function osmHandlers(extra: Handler[] = []): Handler[] {
  return [
    http.get('/api/osm/regions', () => HttpResponse.json({ regions: REGIONS })),
    ...extra,
    ...defaultHandlers,
  ]
}

export const Leer: Story = {
  name: 'Noch keine Regionen angelegt',
}

export const MitRegionen: Story = {
  name: 'Mit Regionen',
  parameters: {
    msw: { handlers: osmHandlers() },
  },
}

export const Schmal: Story = {
  name: 'Mit Regionen (Telefonbreite)',
  parameters: {
    testViewport: { width: 360, height: 740 },
    msw: { handlers: osmHandlers() },
  },
}

export const Quer: Story = {
  name: 'Mit Regionen (Telefon quer)',
  parameters: {
    // The width where the table is shown again: it must scroll inside its
    // own wrapper rather than be cut off by the page's `overflow-x: clip`.
    testViewport: { width: 740, height: 360 },
    msw: { handlers: osmHandlers() },
  },
}

export const Vorschlaege: Story = {
  name: 'Bibliotheks-Vorschläge (Telefonbreite)',
  parameters: {
    testViewport: { width: 360, height: 740 },
    msw: {
      handlers: osmHandlers([
        http.get('/api/osm/regions/bulk-suggest', () => HttpResponse.json(BULK_RESULT)),
      ]),
    },
  },
  play: async ({ canvasElement }) => {
    const button = Array.from(canvasElement.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Regionen aus Foto-Bibliothek vorschlagen'),
    )
    if (!button) throw new Error('bulk suggest button not found')
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 400))
  },
}
