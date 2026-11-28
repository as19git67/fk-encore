import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import HomePartsView from '../views/HomePartsView.vue'
import { defaultHandlers } from './handlers'
import { routeFromParameters } from './storyRoute'
import type { HomePartListItem } from '../api/home'

/** Haus › Ersatzteile: invented parts of an invented house. */

const base: Omit<HomePartListItem, 'id' | 'name'> = {
  manufacturer: null,
  partNumber: null,
  specification: null,
  storageLocation: null,
  stock: null,
  systems: [],
  coverMediaId: null,
  updatedAt: '2026-11-20T10:00:00Z',
  groupId: 7,
  groupName: 'Familie',
  household: true,
  ownerUserId: 1,
  ownerName: 'Admin',
  canManage: true,
}

export const HOME_PARTS: HomePartListItem[] = [
  { ...base, id: 62, name: 'Dichtung für Perlator', specification: 'Gummi, 20 × 15 mm', storageLocation: 'Teileschrank, Schublade 2', stock: 6, systems: [{ id: 3, name: 'Perlatoren' }] },
  { ...base, id: 63, name: 'Filterkartusche', manufacturer: 'Beispielwerk', partNumber: 'FK-10', storageLocation: 'Hauswirtschaftsraum, Regal oben', stock: 1, systems: [{ id: 1, name: 'Enthärtungsanlage' }], coverMediaId: 71 },
  { ...base, id: 61, name: 'Perlator M24×1', manufacturer: 'Beispielwerk', partNumber: 'PL-24', storageLocation: 'Teileschrank, Schublade 2', stock: 0, systems: [{ id: 3, name: 'Perlatoren' }] },
  { ...base, id: 64, name: 'Regeneriersalz', specification: 'Tabletten, 25 kg', storageLocation: 'Keller', systems: [{ id: 1, name: 'Enthärtungsanlage' }] },
]

const handlers = (parts: HomePartListItem[]) => [
  http.get('/api/home/parts', ({ request }) => {
    const empty = new URL(request.url).searchParams.get('empty') === 'true'
    return HttpResponse.json({ parts: empty ? parts.filter((p) => p.stock === 0) : parts })
  }),
  http.get('/api/home/share-groups', () => HttpResponse.json({ householdId: 7, groups: [{ id: 7, name: 'Familie', household: true }] })),
  // A drawn stand-in for a photo.
  http.get('/api/home/media/:id/file', () =>
    new HttpResponse(
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="hsl(30 30% 82%)"/><rect x="160" y="80" width="160" height="320" rx="24" fill="hsl(30 15% 55%)"/></svg>',
      { headers: { 'Content-Type': 'image/svg+xml' } },
    ),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof HomePartsView> = {
  title: 'Views/HomePartsView',
  component: HomePartsView,
  decorators: [routeFromParameters('/haus/ersatzteile')],
  parameters: { msw: { handlers: handlers(HOME_PARTS) } },
}

export default meta
type Story = StoryObj<typeof HomePartsView>

export const Liste: Story = { name: 'Ersatzteile des Hauses' }

export const Leer: Story = {
  name: 'Keins mehr da',
  parameters: { route: '/haus/ersatzteile?stock=empty' },
}

export const Telefon: Story = {
  name: 'Auf dem Telefon',
  parameters: { testViewport: { width: 360, height: 800 } },
}

export const Neu: Story = {
  name: 'Noch kein Ersatzteil',
  parameters: { msw: { handlers: handlers([]) } },
}
