import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import HomePartDetailView from '../views/HomePartDetailView.vue'
import { defaultHandlers } from './handlers'
import { routeFromParameters } from './storyRoute'
import type { HomePartDetail } from '../api/home'

/** One invented spare part with its systems, items and a photo. */

const PART: HomePartDetail = {
  id: 61,
  name: 'Perlator M24×1',
  manufacturer: 'Beispielwerk',
  partNumber: 'PL-24',
  ean: '0000000000000',
  specification: 'Außengewinde, Durchflussklasse 6 l/min',
  supplierUrl: 'https://shop.example.test/perlator-pl-24',
  storageLocation: 'Teileschrank, Schublade 2',
  stock: 2,
  notes: 'Immer zwei auf Vorrat halten.',
  systems: [{ id: 3, name: 'Perlatoren' }],
  items: [{ systemId: 3, systemName: 'Perlatoren', itemId: 21, label: 'Küche', location: 'Spüle' }],
  media: [{ id: 72, targetKind: 'part', targetId: 61, caption: 'Mit Dichtung', width: 2048, height: 1365, createdAt: '2026-11-01T10:00:00Z' }],
  coverMediaId: 72,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-20T10:00:00Z',
  groupId: 7,
  groupName: 'Familie',
  household: true,
  ownerUserId: 1,
  ownerName: 'Admin',
  canManage: true,
}

const handlers = (part: HomePartDetail) => [
  http.get('/api/home/parts/:id', () => HttpResponse.json(part)),
  http.get('/api/home/share-groups', () => HttpResponse.json({ householdId: 7, groups: [{ id: 7, name: 'Familie', household: true }] })),
  http.get('/api/home/media/:id/file', () =>
    new HttpResponse(
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="hsl(200 30% 82%)"/><circle cx="300" cy="200" r="110" fill="hsl(200 15% 60%)"/></svg>',
      { headers: { 'Content-Type': 'image/svg+xml' } },
    ),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof HomePartDetailView> = {
  title: 'Views/HomePartDetailView',
  component: HomePartDetailView,
  decorators: [routeFromParameters('/haus/ersatzteile/61')],
  parameters: { msw: { handlers: handlers(PART) } },
}

export default meta
type Story = StoryObj<typeof HomePartDetailView>

export const Teil: Story = { name: 'Ersatzteil mit Bestand und Anlagen' }

export const Leer: Story = {
  name: 'Keins mehr da, nicht zugeordnet',
  parameters: { msw: { handlers: handlers({ ...PART, stock: 0, systems: [], items: [], media: [], supplierUrl: null }) } },
}

export const Telefon: Story = {
  name: 'Auf dem Telefon',
  parameters: { testViewport: { width: 360, height: 800 } },
}
